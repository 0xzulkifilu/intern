// Poll pacing while waiting for a stage.
//
// The interval is the whole design of the watcher: too eager and OpenSea rate-limits
// the bot out of the mint it is waiting for; too lazy and a creator's last-minute
// reschedule goes unnoticed until the drop is gone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pollInterval } from "../src/core/watcher";

describe("pollInterval", () => {
  it("tightens as the stage approaches", () => {
    const hour = pollInterval(3_600_000);
    const minute = pollInterval(60_000);
    const seconds = pollInterval(20_000);
    assert.ok(hour > minute, `${hour} should exceed ${minute}`);
    assert.ok(minute > seconds, `${minute} should exceed ${seconds}`);
  });

  it("never polls faster than the floor", () => {
    // Below this, the bot is rate-limited out of the mint it is waiting for.
    assert.ok(pollInterval(1_000) >= 2_000);
    assert.ok(pollInterval(0) >= 2_000);
    assert.ok(pollInterval(-50_000) >= 2_000);
  });

  it("never sleeps past the ceiling, however far out the stage is", () => {
    // A stage six hours away can still be rescheduled to five minutes from now.
    assert.ok(pollInterval(6 * 3_600_000) <= 60_000);
    assert.ok(pollInterval(Number.MAX_SAFE_INTEGER) <= 60_000);
  });

  it("honours explicit bounds", () => {
    assert.equal(pollInterval(3_600_000, { maxPollMs: 5_000 }), 5_000);
    assert.equal(pollInterval(100, { minPollMs: 500 }), 500);
  });

  it("falls back to the floor for a non-finite input", () => {
    // NaN reaches here when a start time is missing; sleeping NaN ms is an
    // immediate busy loop.
    assert.equal(pollInterval(Number.NaN), 2_000);
    assert.equal(pollInterval(Number.POSITIVE_INFINITY), 2_000);
  });

  it("returns a whole number of milliseconds", () => {
    // setTimeout truncates a fraction, which would slowly desynchronise a long wait.
    assert.ok(Number.isInteger(pollInterval(123_457)));
  });
});
