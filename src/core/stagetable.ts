// The stage table's shape, decided once for both renderers.
//
// The CLI prints plain text and the bot prints Telegram HTML, so they cannot share
// a finished string. What they can share — and what actually drifts when they
// don't — is the decision of which columns exist, what each cell says, and in what
// order the rows come out.
//
// So this module produces cells as plain strings and nothing else. The CLI pads
// them into a box; the bot escapes them into HTML. Neither one decides what a
// column means, which is why `intern check` and the 📊 Stages panel cannot end up
// disagreeing about a drop.

import { ChainProfile } from "./chains";
import {
  StageRow,
  StageTable,
  formatMintsLeft,
  formatWindow,
  kindLabel,
  statusText,
} from "./stages";
import { formatEth } from "./wallets";

export const STAGE_COLUMNS = [
  "stage",
  "price",
  "window",
  "cap",
  "status",
  "mints left",
  "source",
] as const;

export interface StageCells {
  stage: string;
  price: string;
  window: string;
  cap: string;
  status: string;
  mintsLeft: string;
  source: string;
}

/**
 * One row's cells.
 *
 * A null price prints "—" rather than "0 ETH". They are not the same claim: one
 * says the number is not knowable yet, the other says the mint is free, and a free
 * mint is a thing people act on.
 */
export function stageCells(
  row: StageRow,
  chain: ChainProfile,
  fmtTime: (ms: number) => string,
): StageCells {
  return {
    stage: kindLabel(row.kind) === row.label ? kindLabel(row.kind) : `${kindLabel(row.kind)} · ${row.label}`,
    price: row.priceWei === null ? "—" : formatEth(row.priceWei, chain.nativeSymbol),
    window: formatWindow(row, fmtTime),
    cap: row.perWalletCap > 0 ? String(row.perWalletCap) : "—",
    status: statusText(row),
    mintsLeft:
      row.mintsLeft === null || row.mintsTotal === null
        ? "—"
        : `${row.mintsLeft} / ${row.mintsTotal}`,
    source: row.source,
  };
}

export function allStageCells(
  table: StageTable,
  chain: ChainProfile,
  fmtTime: (ms: number) => string,
): StageCells[] {
  return table.rows.map((row) => stageCells(row, chain, fmtTime));
}

/**
 * The two summary lines the spec fixes verbatim, for the drop's actionable stage.
 *
 * Both renderers print these under the table, in this wording: "Time until start:
 * HH:MM:SS" and "Mint left: [X / Total]".
 */
export function stageSummaryLines(row: StageRow | undefined, clockFmt: (ms: number) => string): string[] {
  if (!row) return [];
  const lines: string[] = [];

  if (row.status === "upcoming") {
    lines.push(`Time until start: ${clockFmt(row.countdownMs)}`);
  } else if (row.status === "live" && row.endMs > 0) {
    lines.push(`Time until end:   ${clockFmt(row.countdownMs)}`);
  }
  lines.push(formatMintsLeft(row.mintsLeft, row.mintsTotal));
  return lines;
}
