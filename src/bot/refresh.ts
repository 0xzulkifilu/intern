// Edit pacing for live panels.
//
// Telegram allows roughly one message edit per second per chat and answers the
// rest with 429 plus a retry_after. A panel with a 🔄 Refresh button and a 20s
// auto-refresh loop can exceed that trivially — two taps in a second, or a tap
// that lands on the same tick as the timer — so the pacing is decided here rather
// than scattered across handlers.
//
// Two different limits, because they protect against two different things:
//
//   The manual debounce (3s) protects the *user* from their own repeat taps. A
//   refresh re-reads stages, supply, gas and balances; firing that five times
//   because someone tapped five times wastes RPC quota and returns the same
//   numbers. The tap is still acknowledged — answerCallbackQuery always runs, or
//   the client spins for thirty seconds — it just does not trigger a re-read.
//
//   The hard gap (1s) protects the *connection* from a 429. It applies to every
//   edit regardless of origin, including the auto loop and a stage transition
//   arriving at an awkward moment.
//
// Time is passed in rather than read. Same reason as everywhere else in this
// codebase: a gate that calls Date.now() internally can only be tested by
// sleeping, and a test that sleeps is a test nobody runs.

/** The default debounce for a manual 🔄 Refresh tap. */
export const MANUAL_DEBOUNCE_MS = 3_000;

/** The floor between any two edits of the same message. */
export const MIN_EDIT_GAP_MS = 1_000;

/** How often an auto-refreshing panel re-reads. */
export const AUTO_REFRESH_MS = 20_000;

export type RefreshSource = "manual" | "auto";

/**
 * Decides whether an edit may happen now, and records the ones that do.
 *
 * One instance per live panel. `record` is called only when an edit actually
 * goes out, so a refused refresh does not push the next allowed one further away.
 */
export class EditGate {
  private lastEditMs = 0;

  constructor(
    private readonly debounceMs = MANUAL_DEBOUNCE_MS,
    private readonly minGapMs = MIN_EDIT_GAP_MS,
  ) {}

  /**
   * May a refresh from `source` proceed at `nowMs`?
   *
   * A manual tap is held to the debounce, an auto tick only to the hard gap: the
   * timer already paces itself at 20s, so applying the 3s debounce to it would
   * never fire and would only add a branch that can go wrong.
   */
  allows(source: RefreshSource, nowMs: number): boolean {
    const gap = source === "manual" ? this.debounceMs : this.minGapMs;
    return nowMs - this.lastEditMs >= gap;
  }

  /** Record that an edit went out. */
  record(nowMs: number): void {
    this.lastEditMs = nowMs;
  }

  /** ms until a manual refresh would be allowed again — for the toast text. */
  waitMs(source: RefreshSource, nowMs: number): number {
    const gap = source === "manual" ? this.debounceMs : this.minGapMs;
    return Math.max(0, gap - (nowMs - this.lastEditMs));
  }

  /** Only for tests and for re-arming a panel that was rebuilt from scratch. */
  reset(): void {
    this.lastEditMs = 0;
  }
}

/**
 * The toast shown when a refresh is debounced.
 *
 * Says why nothing happened. A silent refusal is indistinguishable from a bot
 * that has stopped responding, which is the thing people tap repeatedly about.
 */
export function debouncedToast(waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return `Just refreshed — try again in ${seconds}s`;
}
