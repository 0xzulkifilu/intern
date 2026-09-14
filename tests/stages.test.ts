// Stage intelligence: classification, merging, and the cells both renderers print.
//
// The status classifier and the table builder are the two places where a bug is
// invisible rather than loud. A stage misclassified as "ended" simply does not get
// acted on, and a table that silently drops the allowlist row looks exactly like a
// drop that has no allowlist — so both are pinned down here against a fixed clock.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StageRow,
  actionableStage,
  apiNotice,
  apiStageRow,
  buildStageTable,
  byStageOrder,
  classifyStatus,
  countdownFor,
  formatClock,
  formatCoarse,
  formatMintsLeft,
  formatWindow,
  publicStageRow,
  stageKindOf,
  statusIcon,
  statusText,
} from "../src/core/stages";
import { STAGE_COLUMNS, allStageCells, stageCells, stageSummaryLines } from "../src/core/stagetable";
import { DropStage } from "../src/core/opensea";
import { MintPlan, PublicDrop, SupplyInfo } from "../src/core/seadrop";
import { ChainProfile, resolveChain } from "../src/core/chains";

// 2026-03-15T12:00:00Z
const NOW = 1773576000000;
const HOUR = 3_600_000;

const CHAIN = resolveChain("ethereum") as ChainProfile;

function drop(over: Partial<PublicDrop> = {}): PublicDrop {
  return {
    mintPrice: 10_000_000_000_000_000n, // 0.01 ETH
    startTime: Math.floor((NOW - HOUR) / 1000),
    endTime: Math.floor((NOW + HOUR) / 1000),
    maxTotalMintableByWallet: 3,
    feeBps: 500,
    restrictFeeRecipients: true,
    ...over,
  };
}

function supply(over: Partial<SupplyInfo> = {}): SupplyInfo {
  return { totalSupply: 1200n, maxSupply: 5000n, ...over };
}

function plan(over: Partial<MintPlan> = {}): MintPlan {
  return {
    variant: "v1-singleton",
    to: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
    data: "0xdeadbeef",
    value: 10_000_000_000_000_000n,
    drop: drop(),
    feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
    feeRecipientSource: "on-chain",
    nftContract: "0x1111111111111111111111111111111111111111",
    quantity: 1,
    supply: supply(),
    ...over,
  };
}

function apiStage(over: Partial<DropStage> = {}): DropStage {
  return {
    type: "presale",
    label: "Allowlist",
    startMs: NOW - 2 * HOUR,
    endMs: NOW - HOUR,
    isPublic: false,
    ...over,
  } as DropStage;
}

describe("classifyStatus", () => {
  it("calls a stage live between start and end", () => {
    assert.equal(classifyStatus(NOW - HOUR, NOW + HOUR, NOW), "live");
  });

  it("calls a stage upcoming before start", () => {
    assert.equal(classifyStatus(NOW + HOUR, NOW + 2 * HOUR, NOW), "upcoming");
  });

  it("calls a stage ended at and after its end", () => {
    assert.equal(classifyStatus(NOW - 2 * HOUR, NOW, NOW), "ended");
    assert.equal(classifyStatus(NOW - 2 * HOUR, NOW - HOUR, NOW), "ended");
  });

  it("is live exactly at the start instant", () => {
    // T-0 itself: the mint is open, not "about to be". Off by one here means
    // firing a block late on every drop.
    assert.equal(classifyStatus(NOW, NOW + HOUR, NOW), "live");
  });

  it("treats endMs === 0 as no end, not as 1970", () => {
    // SeaDrop's "no end configured". Reading it as an epoch would mark an
    // open-ended live stage ended and hide it from the table entirely.
    assert.equal(classifyStatus(NOW - HOUR, 0, NOW), "live");
    assert.equal(classifyStatus(NOW + HOUR, 0, NOW), "upcoming");
  });
});

describe("countdownFor", () => {
  it("counts down to start when upcoming", () => {
    assert.equal(countdownFor("upcoming", NOW + 90_000, 0, NOW), 90_000);
  });

  it("counts down to end when live and bounded", () => {
    assert.equal(countdownFor("live", NOW - HOUR, NOW + 45_000, NOW), 45_000);
  });

  it("is zero for a live stage with no end, and for an ended stage", () => {
    assert.equal(countdownFor("live", NOW - HOUR, 0, NOW), 0);
    assert.equal(countdownFor("ended", NOW - 2 * HOUR, NOW - HOUR, NOW), 0);
  });

  it("never returns a negative countdown", () => {
    assert.equal(countdownFor("upcoming", NOW - 5_000, 0, NOW), 0);
  });
});

describe("stageKindOf", () => {
  it("reads the kind from the type field", () => {
    assert.equal(stageKindOf("public_sale", ""), "public");
    assert.equal(stageKindOf("presale", ""), "allowlist");
  });

  it("reads GTD and FCFS out of the label, where they actually live", () => {
    // OpenSea reports both halves of an allowlist as "presale"; only the creator's
    // label distinguishes the guaranteed spots from the scramble for leftovers.
    assert.equal(stageKindOf("presale", "GTD"), "gtd");
    assert.equal(stageKindOf("presale", "Guaranteed"), "gtd");
    assert.equal(stageKindOf("presale", "FCFS"), "fcfs");
    assert.equal(stageKindOf("presale", "First Come First Served"), "fcfs");
  });

  it("recognises team and reserve stages", () => {
    assert.equal(stageKindOf("presale", "Team"), "team");
    assert.equal(stageKindOf("presale", "Founders"), "team");
  });

  it("falls back to unknown rather than guessing", () => {
    assert.equal(stageKindOf("something_new", "Phase 4"), "unknown");
  });
});

describe("publicStageRow", () => {
  it("reads price, window and cap from the contract struct", () => {
    const row = publicStageRow(drop(), supply(), NOW);
    assert.equal(row.kind, "public");
    assert.equal(row.source, "on-chain");
    assert.equal(row.priceWei, 10_000_000_000_000_000n);
    assert.equal(row.perWalletCap, 3);
    assert.equal(row.status, "live");
  });

  it("derives mints left from collection supply", () => {
    const row = publicStageRow(drop(), supply(), NOW);
    assert.equal(row.mintsLeft, 3800n);
    assert.equal(row.mintsTotal, 5000n);
  });

  it("reports a sold-out drop as zero left, not a negative", () => {
    const row = publicStageRow(drop(), supply({ totalSupply: 5000n }), NOW);
    assert.equal(row.mintsLeft, 0n);
  });

  it("leaves mints unknown when supply is unreadable", () => {
    const row = publicStageRow(drop(), { totalSupply: null, maxSupply: null }, NOW);
    assert.equal(row.mintsLeft, null);
    assert.equal(row.mintsTotal, null);
  });
});

describe("apiStageRow", () => {
  it("marks the row as API-sourced and leaves price unknown", () => {
    // The schedule endpoint returns windows but never prices — the price arrives
    // in the signed payload at mint time. A guessed number here would look sourced.
    const row = apiStageRow(apiStage(), NOW);
    assert.equal(row.source, "OpenSea API");
    assert.equal(row.priceWei, null);
    assert.equal(row.perWalletCap, 0);
    assert.equal(row.note, "price known at mint time");
  });

  it("classifies against the clock like any other row", () => {
    assert.equal(apiStageRow(apiStage(), NOW).status, "ended");
    assert.equal(
      apiStageRow(apiStage({ startMs: NOW + HOUR, endMs: NOW + 2 * HOUR }), NOW).status,
      "upcoming",
    );
  });

  it("falls back to the type when the stage has no label", () => {
    assert.equal(apiStageRow(apiStage({ label: "" }), NOW).label, "presale");
  });
});

describe("buildStageTable", () => {
  it("puts the on-chain public stage in the table", () => {
    const table = buildStageTable({
      plan: plan(),
      supply: supply(),
      schedule: null,
      nowMs: NOW,
      hasApiKey: true,
    });
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0]!.kind, "public");
    assert.equal(table.rows[0]!.source, "on-chain");
  });

  it("merges API stages with the on-chain one", () => {
    const table = buildStageTable({
      plan: plan(),
      supply: supply(),
      schedule: {
        slug: "x",
        chain: "ethereum",
        contractAddress: "0x1",
        stages: [apiStage({ label: "GTD" }), apiStage({ label: "FCFS" })],
      },
      nowMs: NOW,
      hasApiKey: true,
    });
    assert.equal(table.rows.length, 3);
    assert.equal(table.hasApiData, true);
    assert.deepEqual(table.rows.map((r) => r.kind), ["gtd", "fcfs", "public"]);
  });

  it("prefers the contract's public stage over OpenSea's copy of it", () => {
    // Both describe the same stage, but only one is what the contract enforces.
    // A creator who edits the schedule without reconfiguring the contract produces
    // exactly this disagreement, and the on-chain row is the one that pays out.
    const table = buildStageTable({
      plan: plan(),
      supply: supply(),
      schedule: {
        slug: "x",
        chain: "ethereum",
        contractAddress: "0x1",
        stages: [apiStage({ type: "public_sale", label: "Public", isPublic: true })],
      },
      nowMs: NOW,
      hasApiKey: true,
    });
    const publicRows = table.rows.filter((r) => r.kind === "public");
    assert.equal(publicRows.length, 1);
    assert.equal(publicRows[0]!.source, "on-chain");
  });

  it("still lists API stages when there is no on-chain plan", () => {
    const table = buildStageTable({
      plan: null,
      supply: supply(),
      schedule: {
        slug: "x",
        chain: "ethereum",
        contractAddress: "0x1",
        stages: [apiStage({ type: "public_sale", label: "Public", isPublic: true })],
      },
      nowMs: NOW,
      hasApiKey: true,
    });
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0]!.source, "OpenSea API");
  });

  it("states what is missing instead of silently omitting it", () => {
    const table = buildStageTable({
      plan: plan(),
      supply: supply(),
      schedule: null,
      nowMs: NOW,
      hasApiKey: false,
    });
    assert.ok(table.apiNotice, "a keyless table must carry a notice");
    assert.match(table.apiNotice!, /OPENSEA_API_KEY/);
  });
});

describe("apiNotice", () => {
  it("tells a keyless user which stages they cannot see and how", () => {
    const notice = apiNotice(false, 0);
    assert.match(notice!, /Allowlist, FCFS, GTD and team/);
    assert.match(notice!, /OPENSEA_API_KEY/);
  });

  it("distinguishes a failed request from an empty schedule", () => {
    // Different situations: one is transient and worth retrying, the other is a
    // fact about the drop. Collapsing them hides the actionable one.
    assert.match(apiNotice(true, 0, "HTTP 503")!, /could not be read/);
    assert.match(apiNotice(true, 0)!, /no additional stages/);
  });

  it("says nothing when the table is complete", () => {
    assert.equal(apiNotice(true, 3), undefined);
  });
});

describe("byStageOrder", () => {
  it("orders by drop shape, then by clock", () => {
    const rows = [
      apiStageRow(apiStage({ label: "Public", type: "public_sale" }), NOW),
      apiStageRow(apiStage({ label: "FCFS" }), NOW),
      apiStageRow(apiStage({ label: "Team" }), NOW),
      apiStageRow(apiStage({ label: "GTD" }), NOW),
    ];
    rows.sort(byStageOrder);
    assert.deepEqual(rows.map((r) => r.kind), ["team", "gtd", "fcfs", "public"]);
  });

  it("breaks ties on start time", () => {
    const early = apiStageRow(apiStage({ label: "GTD", startMs: NOW }), NOW);
    const late = apiStageRow(apiStage({ label: "GTD", startMs: NOW + HOUR }), NOW);
    assert.ok(byStageOrder(early, late) < 0);
  });
});

describe("actionableStage", () => {
  const table = (rows: StageRow[]) => ({ rows, hasApiData: false, supply: supply() });

  it("picks the live public stage", () => {
    const live = publicStageRow(drop(), supply(), NOW);
    assert.equal(actionableStage(table([live]), NOW), live);
  });

  it("picks the next public stage when none is live", () => {
    const soon = publicStageRow(
      drop({ startTime: Math.floor((NOW + HOUR) / 1000), endTime: Math.floor((NOW + 2 * HOUR) / 1000) }),
      supply(),
      NOW,
    );
    const later = publicStageRow(
      drop({ startTime: Math.floor((NOW + 5 * HOUR) / 1000), endTime: 0 }),
      supply(),
      NOW,
    );
    assert.equal(actionableStage(table([later, soon]), NOW), soon);
  });

  it("ignores non-public stages — they cannot be fired at", () => {
    // An allowlist stage needs a server signature intern does not hold; offering it
    // as the thing to mint would be offering a transaction that always reverts.
    const allow = apiStageRow(apiStage({ label: "GTD", startMs: NOW, endMs: NOW + HOUR }), NOW);
    assert.equal(actionableStage(table([allow]), NOW), undefined);
  });

  it("returns undefined for a finished drop", () => {
    const ended = publicStageRow(
      drop({ startTime: Math.floor((NOW - 5 * HOUR) / 1000), endTime: Math.floor((NOW - HOUR) / 1000) }),
      supply(),
      NOW,
    );
    assert.equal(actionableStage(table([ended]), NOW), undefined);
  });
});

describe("formatting", () => {
  it("formats the countdown as HH:MM:SS", () => {
    assert.equal(formatClock(0), "00:00:00");
    assert.equal(formatClock(45_000), "00:00:45");
    assert.equal(formatClock(3_661_000), "01:01:01");
    assert.equal(formatClock(-5_000), "00:00:00");
  });

  it("formats durations at two units, never three", () => {
    assert.equal(formatCoarse(45_000), "45s");
    assert.equal(formatCoarse(3_600_000), "1h 0m");
    assert.equal(formatCoarse(90_000), "1m 30s");
    assert.equal(formatCoarse(200_000_000), "2d 7h");
  });

  it("formats mints left in the spec's exact wording", () => {
    assert.equal(formatMintsLeft(123n, 5000n), "Mint left: [123 / 5000]");
    assert.equal(formatMintsLeft(null, null), "Mint left: [unknown]");
  });

  it("says 'no end' rather than printing a zero date", () => {
    const row = publicStageRow(drop({ endTime: 0 }), supply(), NOW);
    assert.match(formatWindow(row, () => "T"), /no end$/);
  });

  it("puts the right icon on each status", () => {
    assert.equal(statusIcon("ended"), "🔴");
    assert.equal(statusIcon("live"), "🟢");
    assert.equal(statusIcon("upcoming"), "⏳");
  });

  it("says what the countdown means, not just how long", () => {
    // "2h 14m" next to a coloured dot does not say whether the stage is about to
    // open or about to close.
    const upcoming = publicStageRow(
      drop({ startTime: Math.floor((NOW + HOUR) / 1000) }),
      supply(),
      NOW,
    );
    assert.match(statusText(upcoming), /^⏳ opens in /);

    const live = publicStageRow(drop(), supply(), NOW);
    assert.match(statusText(live), /^🟢 live now · ends in /);

    const open = publicStageRow(drop({ endTime: 0 }), supply(), NOW);
    assert.equal(statusText(open), "🟢 live now");
  });
});

describe("stage cells", () => {
  it("prints an unknown price as — and never as 0 ETH", () => {
    // "0 ETH" is a claim that the mint is free, which is a thing people act on.
    const cells = stageCells(apiStageRow(apiStage(), NOW), CHAIN, () => "T");
    assert.equal(cells.price, "—");
    assert.equal(cells.cap, "—");
    assert.equal(cells.mintsLeft, "—");
  });

  it("labels every row with its source", () => {
    const onChain = stageCells(publicStageRow(drop(), supply(), NOW), CHAIN, () => "T");
    const fromApi = stageCells(apiStageRow(apiStage(), NOW), CHAIN, () => "T");
    assert.equal(onChain.source, "on-chain");
    assert.equal(fromApi.source, "OpenSea API");
  });

  it("does not repeat the kind when the label says the same thing", () => {
    const cells = stageCells(publicStageRow(drop(), supply(), NOW), CHAIN, () => "T");
    assert.equal(cells.stage, "Public");
  });

  it("keeps a creator's label alongside the kind", () => {
    const row = apiStageRow(apiStage({ label: "Early Birds", type: "presale" }), NOW);
    assert.equal(stageCells(row, CHAIN, () => "T").stage, "Allowlist · Early Birds");
  });

  it("emits one cell set per row, in table order", () => {
    const table = buildStageTable({
      plan: plan(),
      supply: supply(),
      schedule: {
        slug: "x",
        chain: "ethereum",
        contractAddress: "0x1",
        stages: [apiStage({ label: "GTD" })],
      },
      nowMs: NOW,
      hasApiKey: true,
    });
    const cells = allStageCells(table, CHAIN, () => "T");
    assert.equal(cells.length, table.rows.length);
    assert.equal(STAGE_COLUMNS.length, 7);
    // Every column the header promises must exist on every row, or the CLI's
    // padded table and the bot's labelled lines fall out of step.
    for (const cell of cells) {
      assert.equal(Object.keys(cell).length, STAGE_COLUMNS.length);
    }
  });
});

describe("stageSummaryLines", () => {
  it("uses the spec's verbatim countdown wording", () => {
    const row = publicStageRow(
      drop({ startTime: Math.floor((NOW + 3_661_000) / 1000) }),
      supply(),
      NOW,
    );
    const lines = stageSummaryLines(row, formatClock);
    assert.equal(lines[0], "Time until start: 01:01:01");
    assert.equal(lines[1], "Mint left: [3800 / 5000]");
  });

  it("counts to the end once a stage is live", () => {
    const row = publicStageRow(drop(), supply(), NOW);
    assert.match(stageSummaryLines(row, formatClock)[0]!, /^Time until end:/);
  });

  it("omits the countdown for an open-ended live stage", () => {
    const row = publicStageRow(drop({ endTime: 0 }), supply(), NOW);
    const lines = stageSummaryLines(row, formatClock);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^Mint left:/);
  });

  it("returns nothing when there is no actionable stage", () => {
    assert.deepEqual(stageSummaryLines(undefined, formatClock), []);
  });
});
