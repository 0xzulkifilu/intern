// The mint engine: everything between "we know the target" and "we have receipts".
//
// The ordering here is the whole point of the tool, so it is worth stating
// plainly. Work is either *preparation* (can happen before the stage opens) or
// *dispatch* (must happen at T-0). Anything that can be moved from the second
// category into the first, is.
//
//   Preparation, in parallel where independent:
//     · warm every socket (TLS handshake ≈ 100-300ms, paid once, in advance)
//     · read the drop, fees, nonces, balances
//     · simulate the mint with eth_call so a revert is discovered now, not at T-0
//     · sign every wallet's transaction and serialize the JSON-RPC body
//     · measure the local clock's error against the chain
//
//   Dispatch, at T-0:
//     · write already-built bytes to already-open sockets
//
// That leaves the firing path with no signing, no encoding, no API call and no
// JSON serialization — which is why it is measured in microseconds while the
// preparation phase takes seconds.
//
// The engine emits structured events rather than printing, so the CLI and the
// Telegram bot render the same run without either owning the logic.

import { JsonRpcProvider, Wallet } from "ethers";
import { ChainProfile } from "./chains";
import { CorrectedClock, ClockSync, syncClock } from "./clock";
import {
  BlastOutcome,
  Endpoint,
  PreparedTx,
  blast,
  classifyRejection,
  prepare,
  waitForReceipt,
  wasAccepted,
  warmConnections,
} from "./blast";
import { MintPlan, fetchMintStats, planWarnings } from "./seadrop";
import { labelFor } from "./rpc";
import { FirePlan, formatRemaining, planFire, waitUntil } from "./timing";
import {
  BalanceReport,
  GasSettings,
  LoadedWallet,
  checkBalances,
  fetchNonces,
  formatEth,
  requiredBalance,
} from "./wallets";

export type EngineEvent =
  | { type: "phase"; name: string; detail?: string }
  | { type: "clock"; sync: ClockSync }
  | { type: "balances"; reports: BalanceReport[]; required: bigint; symbol: string }
  | { type: "simulation"; ok: boolean; index: number; address: string; error?: string }
  | { type: "signed"; count: number; elapsedMs: number }
  | { type: "countdown"; remainingMs: number; text: string }
  | { type: "fired"; count: number; dispatchMs: number; timingErrorMs: number }
  | { type: "tx"; index: number; address: string; txHash: string }
  | { type: "accepted"; index: number; label: string; elapsedMs: number }
  | { type: "rejected"; index: number; reasons: string[]; hint?: string }
  | {
      type: "receipt";
      index: number;
      txHash: string;
      block: number;
      position: number;
      success: boolean;
      gasUsed: bigint;
    }
  | { type: "receiptTimeout"; index: number; txHash: string }
  | { type: "warning"; message: string }
  | { type: "done"; minted: number; failed: number };

export interface EngineOptions {
  chain: ChainProfile;
  plan: MintPlan;
  wallets: LoadedWallet[];
  /** Read-capable endpoints, fastest first. */
  readUrls: string[];
  /** Broadcast targets — may include send-only sequencers. */
  blastUrls: string[];
  gas: GasSettings;
  /** Corrected-time epoch ms to dispatch. null fires as soon as prepared. */
  fireAtMs: number | null;
  /** Fire this many ms before the stage opens. */
  leadMs?: number;
  /** Skip the eth_call dry run. Faster setup, no revert protection. */
  skipSimulation?: boolean;
  /** Abort before dispatch when any wallet's simulation reverts. */
  requireSimulation?: boolean;
  clockRounds?: number;
  receiptTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface EngineResult {
  minted: number;
  failed: number;
  timingErrorMs: number;
  dispatchMs: number;
  clock: ClockSync;
  txHashes: string[];
}

interface SignedBundle {
  wallet: LoadedWallet;
  prepared: PreparedTx;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Cancelled before dispatch — nothing was sent.");
}

/**
 * Dry-run the mint with eth_call from each wallet's address.
 *
 * This is the single highest-value check in the tool. A mint that will revert —
 * wrong fee recipient, per-wallet cap exceeded, stage not open, sold out — reverts
 * identically in eth_call, at no cost, before any gas is spent. Skipping it means
 * discovering the problem by paying for a failed transaction.
 *
 * Note the deliberate asymmetry: a *successful* simulation is strong evidence,
 * but a *failed* one before the stage opens is expected (NotActive) and must not
 * be treated as a reason to abort. That is why `requireSimulation` is opt-in and
 * why the stage-open state is checked alongside.
 */
async function simulate(
  provider: JsonRpcProvider,
  plan: MintPlan,
  wallets: LoadedWallet[],
  emit: (event: EngineEvent) => void,
): Promise<{ ok: boolean; failures: number }> {
  let failures = 0;
  await Promise.all(
    wallets.map(async (wallet) => {
      try {
        await provider.call({
          from: wallet.address,
          to: plan.to,
          data: plan.data,
          value: plan.value,
        });
        emit({ type: "simulation", ok: true, index: wallet.index, address: wallet.address });
      } catch (err: unknown) {
        failures++;
        const raw = err instanceof Error ? err.message : String(err);
        emit({
          type: "simulation",
          ok: false,
          index: wallet.index,
          address: wallet.address,
          error: describeRevert(raw),
        });
      }
    }),
  );
  return { ok: failures === 0, failures };
}

/**
 * Remove wallets that have already exhausted the SeaDrop per-wallet cap.
 *
 * getMintStats() is optional across NFT contracts. A failed read therefore
 * does not make the wallet ineligible; simulation remains the authoritative
 * fallback for contracts that do not expose this interface.
 */
async function filterMintCapWallets(
  provider: JsonRpcProvider,
  plan: MintPlan,
  wallets: LoadedWallet[],
  emit: (event: EngineEvent) => void,
): Promise<LoadedWallet[]> {
  const cap = plan.drop.maxTotalMintableByWallet;
  if (cap <= 0) return wallets;

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const stats = await fetchMintStats(provider, plan.nftContract, wallet.address);
        const totalAfterMint = stats.minterNumMinted + BigInt(plan.quantity);

        if (totalAfterMint > BigInt(cap)) {
          emit({
            type: "warning",
            message: `W${wallet.index} ${wallet.address} skipped — wallet has already minted ${stats.minterNumMinted}; requested ${plan.quantity} would exceed the per-wallet cap of ${cap}.`,
          });
          return null;
        }

        return wallet;
      } catch {
        // Not every NFT contract exposes getMintStats(). Keep the wallet and
        // let eth_call simulation remain the fallback safety check.
        return wallet;
      }
    }),
  );

  return results.filter((wallet): wallet is LoadedWallet => wallet !== null);
}

/** Turn an ethers/RPC revert blob into something a human can act on. */
export function describeRevert(raw: string): string {
  const text = String(raw ?? "").trim();

  // Ethers/RPC providers often wrap custom-error data inside the message.
  // Keep the original text available, but extract useful standard reasons first.
  const standard = [
    /execution reverted:?\\s*([^"\\n]{3,200})/i,
    /reverted:?\\s*([^"\\n]{3,200})/i,
    /reason[:=]\\s*([^"\\n]{3,200})/i,
  ];

  for (const pattern of standard) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      return `Reverted: ${match[1].trim()}`;
    }
  }

  // Decode common Solidity Error(string) revert payload:
  // 0x08c379a0 + ABI encoded string.
  const hex = /0x08c379a0[0-9a-fA-F]+/.exec(text)?.[0];
  if (hex) {
    try {
      const data = hex.slice(10);
      if (data.length >= 128) {
        const offset = Number.parseInt(data.slice(0, 64), 16);
        const lengthPos = offset * 2;
        const length = Number.parseInt(data.slice(lengthPos, lengthPos + 64), 16);
        const reasonHex = data.slice(lengthPos + 64, lengthPos + 64 + length * 2);
        const reason = Buffer.from(reasonHex, "hex").toString("utf8").replace(/\\0+$/g, "").trim();
        if (reason) return `Reverted: ${reason}`;
      }
    } catch {
      // Fall through to the generic message below.
    }
  }

  // Decode Solidity Panic(uint256):
  // 0x4e487b71 + uint256 panic code.
  const panic = /0x4e487b71([0-9a-fA-F]{64})/.exec(text);
  if (panic) {
    const code = Number.parseInt(panic[1] ?? "", 16);
    const reasons: Record<number, string> = {
      0x01: "assertion failed",
      0x11: "arithmetic overflow/underflow",
      0x12: "division or modulo by zero",
      0x21: "invalid enum conversion",
      0x22: "incorrectly encoded storage byte array",
      0x31: "pop on empty array",
      0x32: "array index out of bounds",
      0x41: "memory allocation overflow",
      0x51: "call to uninitialized function",
    };
    return `Reverted: Solidity panic 0x${code.toString(16)}${reasons[code] ? ` — ${reasons[code]}` : ""}`;
  }

    // Decode SeaDrop: MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)
    const capError = /0xedc01273([0-9a-fA-F]{64})([0-9a-fA-F]{64})/i.exec(text);
    if (capError) {
      const total = BigInt(`0x${capError[1] ?? "0"}`);
      const allowed = BigInt(`0x${capError[2] ?? "0"}`);
      return `Reverted: wallet mint cap exceeded — total would be ${total}, allowed ${allowed}`;
    }

    // Other custom errors do not carry a human-readable string unless we know their ABI.
    const custom = /0x[0-9a-fA-F]{8,}/.exec(text)?.[0];
    if (custom) {
      return `Reverted: custom error (${custom.slice(0, 10)}…)`;
    }

  return "Reverted (no reason given).";
}

export async function runMint(
  opts: EngineOptions,
  emit: (event: EngineEvent) => void,
): Promise<EngineResult> {
  const {
    chain,
    plan,
    wallets,
    readUrls,
    blastUrls,
    gas,
    fireAtMs,
    signal,
    skipSimulation = false,
    requireSimulation = false,
  } = opts;

  if (wallets.length === 0) throw new Error("No wallets loaded — nothing to mint with.");
  if (blastUrls.length === 0) throw new Error("No RPC endpoints available to broadcast to.");
  if (readUrls.length === 0) {
    throw new Error("No read-capable RPC endpoint — cannot fetch nonces or verify the chain.");
  }

  const provider = new JsonRpcProvider(readUrls[0], chain.chainId, {
    staticNetwork: true, // skip the chainId round trip on every call
  });
  const endpoints: Endpoint[] = blastUrls.map((url) => ({ url, label: labelFor(url) }));
  const clock = new CorrectedClock(0);

  try {
    // ── Preparation, concurrent where the work is independent ──────────────
    emit({ type: "phase", name: "prepare", detail: `${wallets.length} wallet(s), ${endpoints.length} endpoint(s)` });

    for (const warning of planWarnings(plan, Date.now())) {
      emit({ type: "warning", message: warning });
    }

    const required = requiredBalance(plan.value, gas);
    const [, clockSync, nonces, balances] = await Promise.all([
      warmConnections(blastUrls),
      syncClock(readUrls, chain.blockTimeSec, { rounds: opts.clockRounds ?? 3 }),
      fetchNonces(provider, wallets),
      checkBalances(provider, wallets, required),
    ]);
    throwIfAborted(signal);

    clock.applySync(clockSync);
    emit({ type: "clock", sync: clockSync });
    emit({ type: "balances", reports: balances, required, symbol: chain.nativeSymbol });

    const fundedWallets = wallets.filter((w) => balances[w.index]?.sufficient !== false);
    if (fundedWallets.length === 0) {
      throw new Error(
        `Every wallet is short of ${formatEth(required, chain.nativeSymbol)} (value + gasLimit × maxFeePerGas) — nothing can be broadcast.`,
      );
    }
    if (fundedWallets.length < wallets.length) {
      emit({
        type: "warning",
        message: `${wallets.length - fundedWallets.length} wallet(s) underfunded and skipped; continuing with ${fundedWallets.length}.`,
      });
    }

      // ── Per-wallet mint-cap preflight ──────────────────────────────────────
      const eligibleWallets = await filterMintCapWallets(
        provider,
        plan,
        fundedWallets,
        emit,
      );
      throwIfAborted(signal);

      if (eligibleWallets.length === 0) {
        throw new Error("No funded wallet remains eligible for the requested mint — nothing can be broadcast.");
      }

    // ── Simulation ─────────────────────────────────────────────────────────
    if (!skipSimulation) {
      emit({ type: "phase", name: "simulate" });
      const result = await simulate(provider, plan, eligibleWallets, emit);
      throwIfAborted(signal);
      if (!result.ok && requireSimulation) {
        throw new Error(
          `${result.failures} wallet simulation(s) reverted and --require-simulation is set — nothing was sent.`,
        );
      }
    }

    // ── Sign and serialize everything, before the stage opens ─────────────
    emit({ type: "phase", name: "sign" });
    const signStart = performance.now();
    const bundles: SignedBundle[] = [];
    for (const wallet of eligibleWallets) {
      const nonce = nonces[wallet.index];
      if (nonce === undefined) throw new Error(`Missing nonce for wallet ${wallet.index}.`);
      const raw = await new Wallet(wallet.key).signTransaction({
        to: plan.to,
        data: plan.data,
        value: plan.value,
        nonce,
        maxFeePerGas: gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        gasLimit: gas.gasLimit,
        type: 2,
        chainId: chain.chainId,
      });
      bundles.push({ wallet, prepared: prepare(raw) });
    }
    emit({ type: "signed", count: bundles.length, elapsedMs: performance.now() - signStart });
    throwIfAborted(signal);

    // ── Wait for T-0 ───────────────────────────────────────────────────────
    let timingErrorMs = 0;
    if (fireAtMs !== null) {
      emit({ type: "phase", name: "wait", detail: formatRemaining(fireAtMs - clock.now()) });
      timingErrorMs = await waitUntil(fireAtMs, clock, (progress) => {
        emit({
          type: "countdown",
          remainingMs: progress.remainingMs,
          text: `${formatRemaining(progress.remainingMs)} (${progress.phase})`,
        });
      });
      throwIfAborted(signal);
    }

    // ── Dispatch. Nothing below this line computes anything. ───────────────
    const dispatchStart = performance.now();
    const fired = bundles.map(({ wallet, prepared }) => ({
      wallet,
      handle: blast(prepared, endpoints),
    }));
    const dispatchMs = performance.now() - dispatchStart;

    emit({ type: "fired", count: fired.length, dispatchMs, timingErrorMs });
    for (const { wallet, handle } of fired) {
      emit({ type: "tx", index: wallet.index, address: wallet.address, txHash: handle.txHash });
    }

    // ── Acceptance. "Dispatched" only means bytes were written. ────────────
    const settled = await Promise.all(
      fired.map(async ({ wallet, handle }) => ({
        wallet,
        txHash: handle.txHash,
        outcomes: await handle.outcomes,
      })),
    );

    const accepted: { wallet: LoadedWallet; txHash: string }[] = [];
    for (const { wallet, txHash, outcomes } of settled) {
      if (wasAccepted(outcomes)) {
        const first = firstAcceptance(outcomes);
        emit({
          type: "accepted",
          index: wallet.index,
          label: first?.label ?? "unknown",
          elapsedMs: first?.elapsedMs ?? 0,
        });
        accepted.push({ wallet, txHash });
        continue;
      }
      const reasons = [...new Set(outcomes.map((o) => o.error).filter((e): e is string => !!e))];
      const hint = reasons.map(classifyRejection).find((h): h is string => h !== null);
      emit({ type: "rejected", index: wallet.index, reasons, ...(hint ? { hint } : {}) });
    }

    if (accepted.length === 0) {
      emit({ type: "done", minted: 0, failed: settled.length });
      return {
        minted: 0,
        failed: settled.length,
        timingErrorMs,
        dispatchMs,
        clock: clockSync,
        txHashes: [],
      };
    }

    // ── Receipts ───────────────────────────────────────────────────────────
    emit({ type: "phase", name: "receipts", detail: `${accepted.length} in flight` });
    let minted = 0;
    let failed = settled.length - accepted.length;

    await Promise.all(
      accepted.map(async ({ wallet, txHash }) => {
        const receipt = await waitForReceipt(txHash, readUrls, {
          timeoutMs: opts.receiptTimeoutMs ?? 90_000,
          pollMs: Math.max(200, (chain.blockTimeSec * 1000) / 4),
        });
        if (!receipt) {
          emit({ type: "receiptTimeout", index: wallet.index, txHash });
          return;
        }
        if (receipt.success) minted++;
        else failed++;
        emit({
          type: "receipt",
          index: wallet.index,
          txHash,
          block: receipt.block,
          position: receipt.position,
          success: receipt.success,
          gasUsed: receipt.gasUsed,
        });
      }),
    );

    emit({ type: "done", minted, failed });
    return {
      minted,
      failed,
      timingErrorMs,
      dispatchMs,
      clock: clockSync,
      txHashes: accepted.map((a) => a.txHash),
    };
  } finally {
    provider.destroy();
  }
}

function firstAcceptance(outcomes: BlastOutcome[]): BlastOutcome | undefined {
  return outcomes
    .filter((o) => o.txHash !== null || o.alreadyKnown)
    .sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
}

/** Convenience wrapper so callers don't reimplement the lead-time arithmetic. */
export function resolveFireTime(
  plan: MintPlan,
  mode: "stage" | "now" | { atMs: number },
  leadMs = 0,
): { fireAtMs: number | null; fire: FirePlan | null } {
  if (mode === "now") return { fireAtMs: null, fire: null };
  if (mode === "stage") {
    const fire = planFire(plan.drop.startTime, { leadMs });
    return { fireAtMs: fire.fireAtMs, fire };
  }
  return {
    fireAtMs: mode.atMs - leadMs,
    fire: { fireAtMs: mode.atMs - leadMs, stageOpensAtMs: plan.drop.startTime * 1000, leadMs },
  };
}
