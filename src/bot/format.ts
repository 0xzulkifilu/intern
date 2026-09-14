// Rendering a run into Telegram messages.
//
// The constraint that shapes this file is Telegram's rate limit: roughly one
// message edit per second per chat, and a hard 4096-character cap. A mint emits
// events far faster than that — the countdown alone hops every 50ms near T-0 — so
// events are folded into a single message that updates, rather than a stream of
// messages that scroll.
//
// Two rules keep that from losing information:
//
//   Terminal events (fired, receipt, rejected, done) flush immediately and are
//   never dropped. Progress events (countdown, phase) are throttled and may be
//   coalesced, because only the latest one matters.
//
//   The 50ms fine-timer and busy-spin phases are never sent at all. They exist to
//   hit T-0 precisely; forwarding them would spend the rate limit during the exact
//   second the socket writes need to happen.

import { ChainProfile, explorerTx } from "../core/chains";
import { EngineEvent } from "../core/engine";
import { MintPlan } from "../core/seadrop";
import { RpcPlan, maskRpc } from "../core/rpc";
import { formatEth, weiToGwei } from "../core/wallets";
import { formatRemaining, formatUtc } from "../core/timing";
import { shortAddress } from "../core/target";
import { TelegramClient, bold, code, esc, link } from "./api";

export function formatPlan(plan: MintPlan, chain: ChainProfile, quantity: number): string {
  const startMs = plan.drop.startTime * 1000;
  const endMs = plan.drop.endTime * 1000;
  const now = Date.now();
  const live = now >= startMs && now < endMs;

  const lines = [
    bold("Drop"),
    `chain: ${esc(chain.name)} (id ${chain.chainId})`,
    `contract: ${code(shortAddress(plan.nftContract))}`,
    `variant: ${esc(plan.variant === "v1-singleton" ? "SeaDrop v1 singleton" : "SeaDrop v2 (token contract)")}`,
    `price: ${esc(formatEth(plan.drop.mintPrice, chain.nativeSymbol))} × ${quantity} = ${bold(formatEth(plan.value, chain.nativeSymbol))} per wallet`,
    `per-wallet cap: ${plan.drop.maxTotalMintableByWallet > 0 ? plan.drop.maxTotalMintableByWallet : "unlimited"}`,
  ];

  if (plan.supply.maxSupply !== null && plan.supply.totalSupply !== null) {
    lines.push(`supply: ${plan.supply.totalSupply}/${plan.supply.maxSupply} minted`);
  }
  lines.push(
    live
      ? `window: ${bold("open now")} until ${esc(formatUtc(endMs))}`
      : `opens: ${esc(formatUtc(startMs))} — in ${esc(formatRemaining(startMs - now))}`,
  );
  lines.push(`\n${esc("Calldata built from on-chain state — no OpenSea key needed.")}`);
  return lines.join("\n");
}

export function formatRpcPlan(plan: RpcPlan, chain: ChainProfile): string {
  const lines = [bold("Endpoints")];
  for (const health of plan.health) {
    const dropped = plan.dropped.includes(health);
    const mark = dropped ? "✗" : health.readable ? "✓" : "·";
    const detail = dropped
      ? `wrong chain (${health.chainId})`
      : health.readable
        ? `${health.latencyMs}ms`
        : "send-only";
    lines.push(`${mark} ${esc(health.label)} — ${esc(detail)}`);
  }
  lines.push(
    `\n${esc(`chain ${chain.chainId} verified · broadcasting to ${plan.blast.length} endpoint(s)`)}`,
  );
  if (plan.read[0]) lines.push(esc(`reads: ${maskRpc(plan.read[0])}`));
  return lines.join("\n");
}

export function formatGas(
  maxFeeWei: bigint,
  priorityWei: bigint,
  gasLimit: bigint,
  baseFeeWei: bigint | null,
  symbol: string,
): string {
  const lines = [bold("Gas")];
  if (baseFeeWei !== null) lines.push(`base fee now: ${weiToGwei(baseFeeWei).toFixed(4)} gwei`);
  lines.push(`ceiling: ${weiToGwei(maxFeeWei).toFixed(4)} gwei ${esc("(a maximum, not a payment)")}`);
  lines.push(`tip: ${weiToGwei(priorityWei).toFixed(4)} gwei`);
  lines.push(`gas limit: ${gasLimit}`);
  lines.push(`worst case: ${esc(formatEth(gasLimit * maxFeeWei, symbol))} per wallet`);
  return lines.join("\n");
}

/**
 * A Telegram message that updates in place, rate-limit aware.
 *
 * Appends are buffered and written at most every `intervalMs`; `flush` forces a
 * write for events that must not wait. When the buffer outgrows Telegram's message
 * cap the oldest lines are dropped and a marker is left, so the tail — which is
 * where the outcome is — always survives.
 */
export class LiveMessage {
  private lines: string[] = [];
  private messageId: number | null = null;
  private lastWrite = 0;
  private pending: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dropped = 0;
  /** Replaced on every update rather than appended — for countdowns. */
  private tail: string | null = null;

  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: number,
    private readonly header: string,
    private readonly intervalMs = 1_200,
  ) {}

  append(line: string): void {
    this.lines.push(line);
    // Keep the message under Telegram's cap by dropping the oldest body lines.
    while (this.lines.join("\n").length > 3_600 && this.lines.length > 1) {
      this.lines.shift();
      this.dropped++;
    }
    this.schedule();
  }

  setTail(line: string | null): void {
    this.tail = line;
    this.schedule();
  }

  private render(): string {
    const parts = [this.header];
    if (this.dropped > 0) parts.push(esc(`… ${this.dropped} earlier line(s) omitted`));
    parts.push(...this.lines);
    if (this.tail) parts.push(this.tail);
    return parts.join("\n");
  }

  private schedule(): void {
    if (this.pending) return;
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastWrite));
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.write();
    }, wait);
  }

  /** Write now, and wait for it. Used for events that must not be lost. */
  async flush(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    await this.write();
  }

  private write(): Promise<void> {
    // Serialize writes: two concurrent edits of the same message race, and the
    // loser's content is silently discarded.
    this.writing = this.writing.then(async () => {
      this.lastWrite = Date.now();
      const text = this.render();
      try {
        if (this.messageId === null) {
          const sent = await this.client.sendMessage(this.chatId, text);
          this.messageId = sent.message_id;
        } else {
          await this.client.editMessage(this.chatId, this.messageId, text);
        }
      } catch {
        // A failed edit must never abort a mint. The next write carries the same
        // content, so nothing is lost unless every write fails.
      }
    });
    return this.writing;
  }

  async settle(): Promise<void> {
    await this.flush();
    await this.writing;
  }
}

/**
 * Build an event handler that renders a run into one live message.
 *
 * Returns the handler plus a `settle` that resolves once every buffered write has
 * landed — the caller awaits it before reporting the run as finished, so the last
 * message a user sees is the real outcome and not a stale countdown.
 */
export function createTelegramReporter(
  client: TelegramClient,
  chatId: number,
  chain: ChainProfile,
): { handle: (event: EngineEvent) => void; settle: () => Promise<void> } {
  const live = new LiveMessage(client, chatId, bold("Minting"));
  let lastCountdown = 0;

  const handle = (event: EngineEvent): void => {
    switch (event.type) {
      case "phase": {
        const names: Record<string, string> = {
          prepare: "Preparing",
          simulate: "Simulating",
          sign: "Signing",
          wait: "Waiting for T-0",
          receipts: "Waiting for receipts",
        };
        live.append(`\n${bold(names[event.name] ?? event.name)}${event.detail ? esc(` — ${event.detail}`) : ""}`);
        break;
      }

      case "clock": {
        if (!event.sync.synced) {
          live.append(esc("⚠ clock not measured — using the local clock as-is"));
          break;
        }
        const magnitude = Math.abs(event.sync.offsetMs);
        live.append(
          magnitude < 50
            ? esc(`✓ clock accurate (${event.sync.offsetMs >= 0 ? "+" : ""}${event.sync.offsetMs}ms)`)
            : esc(
                `✓ clock is ${magnitude}ms ${event.sync.offsetMs >= 0 ? "slow" : "fast"} — corrected`,
              ),
        );
        break;
      }

      case "balances": {
        for (const report of event.reports) {
          if (report.sufficient) continue;
          live.append(
            esc(`✗ W${report.index} short ${formatEth(report.shortfall, event.symbol)}`),
          );
        }
        live.append(esc(`each wallet needs ${formatEth(event.required, event.symbol)}`));
        break;
      }

      case "simulation":
        live.append(
          event.ok
            ? esc(`✓ W${event.index} simulation passed`)
            : esc(`⚠ W${event.index} ${event.error ?? "simulation failed"}`),
        );
        break;

      case "signed":
        live.append(
          esc(`✓ ${event.count} transaction(s) signed in ${event.elapsedMs.toFixed(1)}ms — nothing left to compute at T-0`),
        );
        break;

      case "countdown": {
        // Only the coarse phase is worth a network round trip, and only every few
        // seconds. The last two seconds are where precision matters most, and
        // spending the rate limit there would be actively harmful.
        if (event.remainingMs < 3_000) break;
        const now = Date.now();
        if (now - lastCountdown < 3_000) break;
        lastCountdown = now;
        live.setTail(esc(`◷ ${formatRemaining(event.remainingMs)} until dispatch`));
        break;
      }

      case "fired":
        live.setTail(null);
        live.append(
          `${bold(`▲ DISPATCHED ${event.count} transaction(s)`)}${esc(` in ${event.dispatchMs.toFixed(2)}ms`)}${
            event.timingErrorMs !== 0
              ? esc(` · ${event.timingErrorMs > 0 ? "+" : ""}${event.timingErrorMs.toFixed(0)}ms from target`)
              : ""
          }`,
        );
        void live.flush();
        break;

      case "tx":
        live.append(link(`W${event.index} tx`, explorerTx(chain.chainId, event.txHash)));
        break;

      case "accepted":
        live.append(esc(`✓ W${event.index} accepted by ${event.label} in ${event.elapsedMs.toFixed(0)}ms`));
        break;

      case "rejected":
        live.append(esc(`✗ W${event.index} rejected by every endpoint — not broadcast`));
        for (const reason of event.reasons.slice(0, 3)) live.append(code(reason.slice(0, 200)));
        if (event.hint) live.append(esc(`→ ${event.hint}`));
        void live.flush();
        break;

      case "receipt":
        live.append(
          `${event.success ? bold("MINTED") : bold("REVERTED")} ${esc(`W${event.index} · block ${event.block} · gas ${event.gasUsed}`)}`,
        );
        void live.flush();
        break;

      case "receiptTimeout":
        live.append(
          `${esc(`⚠ W${event.index} no receipt yet — `)}${link("check on the explorer", explorerTx(chain.chainId, event.txHash))}`,
        );
        break;

      case "warning":
        live.append(esc(`⚠ ${event.message}`));
        break;

      case "done":
        live.setTail(null);
        live.append(
          event.minted > 0
            ? bold(`✓ ${event.minted} wallet(s) minted`)
            : bold("✗ nothing minted"),
        );
        break;
    }
  };

  return { handle, settle: () => live.settle() };
}
