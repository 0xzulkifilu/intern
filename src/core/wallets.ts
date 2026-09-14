// Wallet loading and gas budgeting.
//
// Two rules shape this file:
//
//   Never echo key material. ethers embeds the offending value in some of its
//   own error messages, so every construction failure is caught and replaced with
//   a positional message. A leaked key in a log or a screenshot is unrecoverable.
//
//   Balance checks must model what the *node* requires, not what the mint costs.
//   A node reserves value + gasLimit × maxFeePerGas up front and rejects the
//   transaction outright if the balance falls short — regardless of the far
//   smaller amount actually spent once the block lands. Checking against expected
//   cost passes locally and then fails at broadcast.

import { JsonRpcProvider, Wallet, formatEther } from "ethers";

export interface LoadedWallet {
  index: number;
  address: string;
  key: string;
}

/** Redact anything key-shaped from a string before it reaches a log or a chat. */
export function redactKeys(text: string): string {
  return text
    .replace(/0x[a-fA-F0-9]{64}/g, "0x⟨redacted-key⟩")
    .replace(/\b[a-fA-F0-9]{64}\b/g, "⟨redacted-key⟩")
    .replace(/\b\d{6,10}:[A-Za-z0-9_-]{30,}\b/g, "⟨redacted-bot-token⟩");
}

function toWallet(raw: string, position: number): Wallet {
  const normalized = raw.trim().startsWith("0x") ? raw.trim() : `0x${raw.trim()}`;
  try {
    return new Wallet(normalized);
  } catch {
    // Never forward the underlying error: it may quote the key.
    throw new Error(
      `Private key #${position} is not a valid 32-byte hex key. (Seed phrases are not accepted.)`,
    );
  }
}

/**
 * Load keys from PRIVATE_KEY and PRIVATE_KEYS, deduplicated by address.
 *
 * Both variables are read and merged rather than one taking precedence, because
 * the common setup is a main key in one and extras in the other, and silently
 * ignoring half of them loses mints without any visible error.
 */
export function walletsFromEnv(env: NodeJS.ProcessEnv = process.env): LoadedWallet[] {
  const raw = [env.PRIVATE_KEY ?? "", env.PRIVATE_KEYS ?? ""]
    .join("\n")
    .split(/[\s,;]+/)
    .filter(Boolean);
  return loadWallets(raw);
}

export function loadWallets(rawKeys: string[]): LoadedWallet[] {
  const out: LoadedWallet[] = [];
  const seen = new Set<string>();
  // Blanks come from a trailing comma or a stray newline in a pasted list. They
  // are not a malformed key, and reporting them as one sends people looking for a
  // problem with a key that is fine.
  rawKeys
    .filter((raw) => raw.trim() !== "")
    .forEach((raw, i) => {
      const wallet = toWallet(raw, i + 1);
      const lower = wallet.address.toLowerCase();
      if (seen.has(lower)) return; // duplicate key: same nonce space, would collide
      seen.add(lower);
      out.push({ index: out.length, address: wallet.address, key: wallet.privateKey });
    });
  return out;
}

export interface GasSettings {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
}

export interface FeeSnapshot {
  baseFeeWei: bigint | null;
  suggestedMaxFeeWei: bigint | null;
  suggestedPriorityWei: bigint | null;
}

export async function readFees(provider: JsonRpcProvider): Promise<FeeSnapshot> {
  try {
    const [feeData, block] = await Promise.all([
      provider.getFeeData(),
      provider.getBlock("latest"),
    ]);
    return {
      baseFeeWei: block?.baseFeePerGas ?? null,
      suggestedMaxFeeWei: feeData.maxFeePerGas ?? feeData.gasPrice ?? null,
      suggestedPriorityWei: feeData.maxPriorityFeePerGas ?? null,
    };
  } catch {
    return { baseFeeWei: null, suggestedMaxFeeWei: null, suggestedPriorityWei: null };
  }
}

/**
 * A fee ceiling that clears the base fee with room for it to rise.
 *
 * Base fee can climb 12.5% per block, and a mint that everyone is watching is
 * exactly when it does. 2× base plus the tip survives several consecutive
 * increases; a ceiling set at current base fails on the very next block. The
 * ceiling is a maximum, not a payment — EIP-1559 refunds the difference, so
 * headroom costs nothing when the network stays calm.
 */
export function suggestMaxFee(baseFeeWei: bigint, priorityWei: bigint): bigint {
  return baseFeeWei * 2n + priorityWei;
}

/** What the node reserves per wallet, and therefore what it checks against. */
export function requiredBalance(mintValue: bigint, gas: GasSettings): bigint {
  return mintValue + gas.gasLimit * gas.maxFeePerGas;
}

export interface BalanceReport {
  index: number;
  address: string;
  balance: bigint | null;
  sufficient: boolean;
  shortfall: bigint;
}

export async function checkBalances(
  provider: JsonRpcProvider,
  wallets: LoadedWallet[],
  required: bigint,
): Promise<BalanceReport[]> {
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null)),
  );
  return wallets.map((w, i) => {
    const balance = balances[i] ?? null;
    // An unreadable balance is unknown, not insufficient: refusing to fire on a
    // flaky RPC read would lose the mint for no reason.
    const sufficient = balance === null || balance >= required;
    return {
      index: w.index,
      address: w.address,
      balance,
      sufficient,
      shortfall: balance !== null && balance < required ? required - balance : 0n,
    };
  });
}

/** Highest fee ceiling this balance can sustain, for a useful error message. */
export function affordableMaxFeeGwei(
  balance: bigint,
  mintValue: bigint,
  gasLimit: bigint,
): number {
  if (balance <= mintValue || gasLimit === 0n) return 0;
  const perGas = (balance - mintValue) / gasLimit;
  return Number(perGas) / 1e9;
}

export function gweiToWei(gwei: number): bigint {
  if (!Number.isFinite(gwei) || gwei < 0) throw new Error(`Invalid gwei value: ${gwei}`);
  // Round through wei rather than float-multiplying: 0.1 gwei is not exact in
  // binary floating point and BigInt() rejects a non-integer.
  return BigInt(Math.round(gwei * 1e9));
}

export function weiToGwei(wei: bigint): number {
  return Number(wei) / 1e9;
}

export function formatEth(wei: bigint, symbol = "ETH", decimals = 6): string {
  const value = Number(formatEther(wei));
  // Very small non-zero amounts must not print as "0.000000" — that reads as free.
  if (value > 0 && value < 10 ** -decimals) return `<0.${"0".repeat(decimals - 1)}1 ${symbol}`;
  return `${value.toFixed(decimals).replace(/\.?0+$/, "")} ${symbol}`;
}

/**
 * Fetch pending nonces for every wallet at once.
 *
 * "pending" rather than "latest" so a transaction already sitting in the mempool
 * is counted — using "latest" would reuse its nonce and produce a replacement
 * that gets rejected as underpriced.
 */
export async function fetchNonces(
  provider: JsonRpcProvider,
  wallets: LoadedWallet[],
): Promise<number[]> {
  return Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending")));
}
