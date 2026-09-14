// Render engine events to the terminal.
//
// The engine emits events and knows nothing about output; this file is the only
// place that decides how a run looks. The Telegram bot has its own renderer over
// the same event stream, which is why neither needs to reimplement the mint.
//
// One rule shapes the wording throughout: never report an outcome that has not
// been observed. "Dispatched" means bytes were written to a socket. "Accepted"
// means an endpoint acknowledged the transaction. "Minted" means a receipt with
// status 1 exists. Collapsing those three into "success" is how a tool ends up
// claiming a mint that reverted.

import { ChainProfile, explorerTx } from "../core/chains";
import { EngineEvent } from "../core/engine";
import { MintPlan } from "../core/seadrop";
import { EndpointHealth, RpcPlan, isBenignProbeError, maskRpc } from "../core/rpc";
import { formatEth, weiToGwei } from "../core/wallets";
import { formatLocal, formatRemaining, formatUtc } from "../core/timing";
import { ClockSync } from "../core/clock";
import { StageTable, actionableStage, formatClock } from "../core/stages";
import { STAGE_COLUMNS, allStageCells, stageSummaryLines } from "../core/stagetable";
import {
  c,
  clearTransient,
  fail,
  field,
  heading,
  info,
  ok,
  padLeft,
  table,
  transient,
  warn,
} from "../util/render";

export function printRpcPlan(plan: RpcPlan, chain: ChainProfile): void {
  for (const bad of plan.dropped) {
    process.stdout.write(
      fail(
        `${bad.label} reports chain ${bad.chainId}, not ${chain.chainId} — excluded from broadcasting.\n`,
      ),
    );
  }

  const rows: string[][] = [];
  for (const h of plan.health) {
    if (plan.dropped.includes(h)) continue;
    rows.push(endpointRow(h));
  }
  if (rows.length > 0) process.stdout.write(`${table(rows)}\n`);

  if (plan.read.length === 0) {
    process.stdout.write(warn("No endpoint answered reads — nonces and balances cannot be read.\n"));
  } else {
    process.stdout.write(
      ok(
        `chain ${chain.chainId} (${chain.name}) confirmed · reading from ${maskRpc(plan.read[0]!)}\n`,
      ),
    );
  }
  process.stdout.write(
    info(`broadcasting to ${plan.blast.length} endpoint(s) simultaneously\n`),
  );
}

function endpointRow(h: EndpointHealth): string[] {
  const latency = h.latencyMs === null ? c.gray("—") : `${padLeft(String(h.latencyMs), 4)}ms`;
  if (h.readable) return [`  ${c.green("✓")}`, h.label, latency, ""];
  if (h.error && isBenignProbeError(h.error)) {
    return [`  ${c.gray("·")}`, c.gray(h.label), c.gray("send-only"), c.gray("(reads refused)")];
  }
  return [
    `  ${c.yellow("⚠")}`,
    c.yellow(h.label),
    latency,
    c.gray((h.error ?? "no response").slice(0, 70)),
  ];
}

export function printPlan(plan: MintPlan, chain: ChainProfile, quantity: number): void {
  const { drop } = plan;
  const startMs = drop.startTime * 1000;
  const endMs = drop.endTime * 1000;
  const now = Date.now();
  const live = now >= startMs && now < endMs;

  process.stdout.write(heading("Drop") + "\n");
  process.stdout.write(
    ok(`calldata built from on-chain state — no OpenSea account or token needed\n`),
  );
  process.stdout.write(field("variant", plan.variant === "v1-singleton" ? "SeaDrop v1 singleton" : "SeaDrop v2 (token contract)") + "\n");
  process.stdout.write(field("target", plan.to) + "\n");
  process.stdout.write(field("collection", plan.nftContract) + "\n");
  process.stdout.write(field("fee recipient", `${plan.feeRecipient} ${c.gray(`(${plan.feeRecipientSource})`)}`) + "\n");
  process.stdout.write(
    field(
      "price",
      `${formatEth(drop.mintPrice, chain.nativeSymbol)} × ${quantity} = ${c.bold(formatEth(plan.value, chain.nativeSymbol))} per wallet`,
    ) + "\n",
  );
  process.stdout.write(
    field(
      "per-wallet cap",
      drop.maxTotalMintableByWallet > 0 ? String(drop.maxTotalMintableByWallet) : "unlimited",
    ) + "\n",
  );
  if (plan.supply.maxSupply !== null && plan.supply.totalSupply !== null) {
    process.stdout.write(
      field("supply", `${plan.supply.totalSupply} / ${plan.supply.maxSupply} minted`) + "\n",
    );
  }
  process.stdout.write(field("calldata", `${(plan.data.length - 2) / 2} bytes (identical for every wallet)`) + "\n");
  process.stdout.write(
    field(
      "window",
      `${formatLocal(startMs)} ${c.gray("→")} ${formatLocal(endMs)}  ${
        live ? c.green("(open now)") : c.yellow(`(opens in ${formatRemaining(startMs - now)})`)
      }`,
    ) + "\n",
  );
  process.stdout.write(field("", c.gray(`${formatUtc(startMs)} UTC`)) + "\n");
}

/**
 * The stage table — the same seven columns `intern check` and the 📊 Stages panel
 * both show, because both build their cells from `allStageCells`.
 *
 * The bot renders these cells as labelled lines (a phone cannot hold seven aligned
 * columns); the terminal has the width for a real table, so it gets one. What the
 * columns *mean* is decided in stagetable.ts, so the two cannot disagree about a
 * drop even though they look different.
 */
export function printStages(stages: StageTable, chain: ChainProfile, nowMs: number): void {
  process.stdout.write(heading("Stages") + "\n");

  if (stages.rows.length === 0) {
    process.stdout.write(info("No stages are configured for this drop yet.\n"));
  } else {
    const header = STAGE_COLUMNS.map((h) => c.gray(h));
    const rows: string[][] = [header];
    for (const cell of allStageCells(stages, chain, formatLocal)) {
      rows.push([
        cell.stage,
        cell.price,
        cell.window,
        cell.cap,
        cell.status,
        cell.mintsLeft,
        // The source is what tells "on-chain, untamperable" apart from "OpenSea's
        // copy of the config", so it is never dropped to save a column.
        cell.source === "on-chain" ? c.green(cell.source) : c.gray(cell.source),
      ]);
    }
    process.stdout.write(`${table(rows)}\n`);
  }

  // The two verbatim summary lines, for whichever stage the user can act on next.
  const summary = stageSummaryLines(actionableStage(stages, nowMs), formatClock);
  for (const line of summary) process.stdout.write(field("", line) + "\n");

  if (stages.apiNotice) process.stdout.write(warn(`${stages.apiNotice}\n`));
}

export function printClock(sync: ClockSync): void {
  if (!sync.synced) {
    process.stdout.write(
      warn("Could not measure clock offset — firing against the local clock as-is.\n"),
    );
    return;
  }
  const sign = sync.offsetMs >= 0 ? "+" : "";
  const magnitude = Math.abs(sync.offsetMs);
  const text = `local clock is ${magnitude}ms ${sync.offsetMs >= 0 ? "slow" : "fast"} (offset ${sign}${sync.offsetMs}ms, ±${sync.uncertaintyMs}ms)`;
  // Under ~50ms is normal drift and needs no attention. Beyond ~500ms the machine
  // has a real clock problem, and correcting for it is the difference between
  // firing at T-0 and firing late.
  if (magnitude < 50) process.stdout.write(ok(`${text} — negligible\n`));
  else if (magnitude < 500) process.stdout.write(ok(`${text} — corrected\n`));
  else
    process.stdout.write(
      warn(`${text} — corrected, but consider enabling NTP on this machine\n`),
    );
}

export interface ReporterOptions {
  chain: ChainProfile;
  addresses: string[];
}

/**
 * Build an event handler that renders a run.
 *
 * Stateful only in that it tracks the countdown line so it can be overwritten in
 * place rather than scrolling hundreds of lines.
 */
export function createReporter(opts: ReporterOptions): (event: EngineEvent) => void {
  const { chain } = opts;
  let counting = false;

  const endCountdown = (): void => {
    if (counting) {
      clearTransient();
      counting = false;
    }
  };

  return (event: EngineEvent): void => {
    switch (event.type) {
      case "phase": {
        endCountdown();
        const names: Record<string, string> = {
          prepare: "Preparing",
          simulate: "Simulating",
          sign: "Signing",
          wait: "Waiting for T-0",
          receipts: "Waiting for receipts",
        };
        const label = names[event.name] ?? event.name;
        process.stdout.write(
          heading(label) + (event.detail ? ` ${c.gray(`— ${event.detail}`)}` : "") + "\n",
        );
        break;
      }

      case "clock":
        printClock(event.sync);
        break;

      case "balances": {
        for (const report of event.reports) {
          const balance =
            report.balance === null
              ? c.gray("balance unreadable")
              : formatEth(report.balance, event.symbol);
          const line = `[W${report.index}] ${report.address}  ${balance}`;
          if (report.sufficient) process.stdout.write(info(`${line}\n`));
          else
            process.stdout.write(
              fail(
                `${line}  needs ${formatEth(event.required, event.symbol)} (short ${formatEth(report.shortfall, event.symbol)})\n`,
              ),
            );
        }
        process.stdout.write(
          info(
            `each wallet must hold value + gasLimit × maxFeePerGas = ${formatEth(event.required, event.symbol)}\n`,
          ),
        );
        break;
      }

      case "simulation":
        if (event.ok) process.stdout.write(ok(`[W${event.index}] simulation passed\n`));
        else process.stdout.write(warn(`[W${event.index}] ${event.error ?? "simulation failed"}\n`));
        break;

      case "signed":
        process.stdout.write(
          ok(
            `${event.count} transaction(s) signed and serialized in ${event.elapsedMs.toFixed(1)}ms — nothing left to compute at T-0\n`,
          ),
        );
        break;

      case "countdown":
        counting = true;
        transient(`  ${c.cyan("◷")} ${event.text} until dispatch`);
        break;

      case "fired": {
        endCountdown();
        const drift =
          event.timingErrorMs === 0
            ? ""
            : ` ${c.gray(`· fired ${event.timingErrorMs > 0 ? "+" : ""}${event.timingErrorMs.toFixed(0)}ms from target`)}`;
        process.stdout.write(
          `\n  ${c.bold(c.green(`▲ DISPATCHED ${event.count} transaction(s)`))} ${c.gray(`in ${event.dispatchMs.toFixed(2)}ms`)}${drift}\n`,
        );
        break;
      }

      case "tx":
        process.stdout.write(info(`[W${event.index}] ${event.txHash}\n`));
        break;

      case "accepted":
        process.stdout.write(
          ok(`[W${event.index}] accepted by ${event.label} in ${event.elapsedMs.toFixed(0)}ms\n`),
        );
        break;

      case "rejected":
        process.stdout.write(
          fail(`[W${event.index}] rejected by every endpoint — not broadcast.\n`),
        );
        for (const reason of event.reasons) process.stdout.write(`      ${c.red(reason)}\n`);
        if (event.hint) process.stdout.write(`      ${c.yellow(`→ ${event.hint}`)}\n`);
        break;

      case "receipt": {
        const status = event.success ? c.bold(c.green("MINTED")) : c.bold(c.red("REVERTED"));
        process.stdout.write(
          `  ${status} ${c.gray(`[W${event.index}]`)} block ${event.block} · position ${event.position} · gas ${event.gasUsed}\n`,
        );
        process.stdout.write(info(`${explorerTx(chain.chainId, event.txHash)}\n`));
        break;
      }

      case "receiptTimeout":
        process.stdout.write(
          warn(
            `[W${event.index}] no receipt yet — still pending or dropped: ${explorerTx(chain.chainId, event.txHash)}\n`,
          ),
        );
        break;

      case "warning":
        process.stdout.write(warn(`${event.message}\n`));
        break;

      case "done": {
        endCountdown();
        const summary =
          event.minted > 0
            ? c.bold(c.green(`${event.minted} wallet(s) minted`))
            : c.bold(c.red("nothing minted"));
        const failedPart = event.failed > 0 ? c.gray(` · ${event.failed} failed`) : "";
        process.stdout.write(`\n  ${summary}${failedPart}\n`);
        break;
      }
    }
  };
}

export function printGasSummary(
  maxFeeWei: bigint,
  priorityWei: bigint,
  gasLimit: bigint,
  baseFeeWei: bigint | null,
): void {
  process.stdout.write(heading("Gas") + "\n");
  if (baseFeeWei !== null) {
    process.stdout.write(field("base fee now", `${weiToGwei(baseFeeWei).toFixed(4)} gwei`) + "\n");
  }
  process.stdout.write(
    field("fee ceiling", `${weiToGwei(maxFeeWei).toFixed(4)} gwei ${c.gray("(a maximum, not a payment)")}`) + "\n",
  );
  process.stdout.write(field("priority tip", `${weiToGwei(priorityWei).toFixed(4)} gwei`) + "\n");
  process.stdout.write(field("gas limit", String(gasLimit)) + "\n");
  process.stdout.write(
    field(
      "worst case",
      `${formatEth(gasLimit * maxFeeWei, "ETH")} per wallet if the ceiling is fully used`,
    ) + "\n",
  );
}
