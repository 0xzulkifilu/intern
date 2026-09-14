// Time parsing, and the clock-corrected wait.
//
// `parseTimeInput` takes `nowMs` as an argument precisely so these cases are
// deterministic rather than dependent on when the suite runs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRemaining, parseTimeInput, planFire } from "../src/core/timing";

// 2026-03-15T12:00:00Z
const NOW = 1773576000000;

describe("parseTimeInput", () => {
  it("reads unix seconds and milliseconds", () => {
    assert.equal(parseTimeInput("1773576000", NOW), 1773576000000);
    assert.equal(parseTimeInput("1773576000000", NOW), 1773576000000);
  });

  it("reads relative offsets", () => {
    assert.equal(parseTimeInput("+30s", NOW), NOW + 30_000);
    assert.equal(parseTimeInput("+5m", NOW), NOW + 300_000);
    assert.equal(parseTimeInput("+2h", NOW), NOW + 7_200_000);
    assert.equal(parseTimeInput("+500ms", NOW), NOW + 500);
  });

  it("reads ISO-8601", () => {
    assert.equal(parseTimeInput("2026-03-15T12:30:00Z", NOW), NOW + 1_800_000);
  });

  it("treats HH:MM as the next occurrence", () => {
    // Local-time dependent, so assert the invariant rather than a fixed instant:
    // the result is always in the future, and within 24h.
    const result = parseTimeInput("03:30", NOW);
    assert.ok(result > NOW, "must be in the future");
    assert.ok(result - NOW <= 86_400_000, "must be within 24 hours");
    const parsed = new Date(result);
    assert.equal(parsed.getHours(), 3);
    assert.equal(parsed.getMinutes(), 30);
    assert.equal(parsed.getSeconds(), 0);
  });

  it("accepts HH:MM:SS", () => {
    const result = parseTimeInput("03:30:45", NOW);
    assert.equal(new Date(result).getSeconds(), 45);
  });

  it("rejects an impossible clock time rather than rolling it over", () => {
    // Date would happily accept hour 25 and roll into the next day. A user who
    // typed 25:00 made a mistake, and silently firing at 01:00 is worse than an
    // error.
    assert.throws(() => parseTimeInput("25:00", NOW), /not a valid 24-hour time/);
    assert.throws(() => parseTimeInput("12:99", NOW), /not a valid 24-hour time/);
  });

  it("rejects unparseable input with a message naming the accepted forms", () => {
    assert.throws(() => parseTimeInput("tomorrow-ish", NOW), /HH:MM/);
    assert.throws(() => parseTimeInput("", NOW), /No time given/);
  });
});

describe("planFire", () => {
  it("subtracts the lead time from the stage opening", () => {
    const stageStartSec = Math.floor(NOW / 1000) + 600;
    const plan = planFire(stageStartSec, { leadMs: 250 });
    assert.equal(plan.stageOpensAtMs, stageStartSec * 1000);
    assert.equal(plan.fireAtMs, stageStartSec * 1000 - 250);
    assert.equal(plan.leadMs, 250);
  });

  it("defaults to firing exactly at the opening", () => {
    const stageStartSec = Math.floor(NOW / 1000) + 600;
    const plan = planFire(stageStartSec);
    assert.equal(plan.fireAtMs, plan.stageOpensAtMs);
  });
});

describe("formatRemaining", () => {
  it("drops to the two most significant units", () => {
    assert.equal(formatRemaining(45_000), "45s");
    assert.equal(formatRemaining(125_000), "2m 5s");
    assert.equal(formatRemaining(3_725_000), "1h 2m");
    assert.equal(formatRemaining(90_000_000), "1d 1h");
  });

  it("floors at zero rather than showing a negative countdown", () => {
    assert.equal(formatRemaining(-5_000), "0s");
  });
});
