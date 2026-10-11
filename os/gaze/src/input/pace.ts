/**
 * Pace: when selecting gets harder as a session goes on (tired eyes, a heavier head, dryness),
 * give a little more time and a little more room, without being asked.
 *
 * Two signs of strain, both from what the person already does:
 * - Dwells get slower: the time from first resting on a target to its selection grows (the ring
 *   keeps pausing because the eyes don't hold still). Measured against the person's own start of
 *   the session (the median of their first selections), so a slow, steady person isn't "tired".
 * - More get undone: Back, Undo or Cancel soon after a selection.
 *
 * Each step up lengthens the dwell by 15 % and enlarges targets by 12 % (at most two steps: 1.3x
 * and 1.25x). A step down comes only after a long run of easy selections. Steps are spaced out, so
 * one bad minute doesn't change things, and each change is announced in plain words.
 *
 * Pure and deterministic. Tests: tests/pace.test.ts (a simulated person tiring).
 */

export interface PaceOptions {
  /** Selections that make the person's own baseline. */
  baselineSelections: number;
  /** Recent selections compared with the baseline. */
  window: number;
  /** Slower than baseline by this factor counts as strain. */
  slowerBy: number;
  /** Back to within this factor of baseline counts as easy again. */
  easyWithin: number;
  /** Undone share of recent outcomes that counts as strain, and as easy again. */
  undoneShare: number;
  easyUndoneShare: number;
  /** Selections between changes, at least (and before stepping down, at least `relaxAfter`). */
  spacing: number;
  relaxAfter: number;
  /** Per step. */
  dwellStep: number;
  targetStep: number;
  maxLevel: number;
}

export const DEFAULT_PACE: PaceOptions = {
  baselineSelections: 8,
  window: 8,
  slowerBy: 1.3,
  easyWithin: 1.1,
  undoneShare: 0.3,
  easyUndoneShare: 0.1,
  spacing: 8,
  relaxAfter: 30,
  dwellStep: 0.15,
  targetStep: 0.12,
  maxLevel: 2,
};

export interface PaceState {
  level: number;
  /** Multiply the dwell time by this. */
  dwellScale: number;
  /** Multiply target sizes (and their hit areas) by this. */
  targetScale: number;
}

export interface PaceChange extends PaceState {
  type: "pace";
  t: number;
  /** Plain words for the person. */
  message: string;
  /** What was measured, for support and logs. */
  reason: string;
}

const median = (v: readonly number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

export class PaceMonitor {
  private o: PaceOptions;
  private durations: number[] = [];
  private baseline: number | null = null;
  /** Recent outcomes: true = stood, false = undone. */
  private outcomes: { t: number; ok: boolean }[] = [];
  private level = 0;
  private sinceChange = 0;

  constructor(options: Partial<PaceOptions> = {}) {
    this.o = { ...DEFAULT_PACE, ...options };
  }

  get state(): PaceState {
    return {
      level: this.level,
      dwellScale: 1 + this.o.dwellStep * this.level,
      targetScale: 1 + this.o.targetStep * this.level,
    };
  }

  /** The person changed their dwell time or target settings: measure afresh, keep the level. */
  rebase(): void {
    this.durations = [];
    this.baseline = null;
  }

  reset(): void {
    this.rebase();
    this.outcomes = [];
    this.level = 0;
    this.sinceChange = 0;
  }

  /** A dwell selected something: it took `dwellMs` from first resting on the target. */
  selected(t: number, dwellMs: number): PaceChange | null {
    if (!(dwellMs > 0) || !Number.isFinite(dwellMs)) return null;
    this.durations.push(dwellMs);
    if (this.durations.length > 60) this.durations.shift();
    this.outcomes.push({ t, ok: true });
    if (this.outcomes.length > 12) this.outcomes.shift();
    this.sinceChange += 1;
    if (this.baseline === null && this.durations.length >= this.o.baselineSelections) {
      this.baseline = median(this.durations);
    }
    return this.evaluate(t);
  }

  /** The person undid their last selection (Back, Undo, Cancel soon after it). */
  undone(t: number): PaceChange | null {
    const last = [...this.outcomes].reverse().find((o) => o.ok);
    if (last) last.ok = false;
    return this.evaluate(t);
  }

  private evaluate(t: number): PaceChange | null {
    if (this.baseline === null) return null;
    const recent = this.durations.slice(-this.o.window);
    if (recent.length < this.o.window) return null;
    const ratio = median(recent) / this.baseline;
    const outcomes = this.outcomes.slice(-10);
    const undone = outcomes.filter((o) => !o.ok).length / Math.max(1, outcomes.length);
    const strained = ratio >= this.o.slowerBy || (outcomes.length >= 6 && undone >= this.o.undoneShare);
    const easy = ratio <= this.o.easyWithin && undone <= this.o.easyUndoneShare;
    const measured = `dwells take ${ratio.toFixed(2)}x as long as at the start; ${Math.round(undone * 100)} % of recent choices undone`;
    if (strained && this.level < this.o.maxLevel && this.sinceChange >= this.o.spacing) {
      this.level += 1;
      this.sinceChange = 0;
      // The slowness so far was measured at the old dwell time; compare the new pace with itself.
      this.durations = [];
      this.baseline = this.baseline * (1 + this.o.dwellStep);
      return {
        type: "pace",
        t,
        ...this.state,
        message:
          "Choosing is taking more effort, so AGENCY now gives you a little more time and bigger targets.",
        reason: measured,
      };
    }
    if (easy && this.level > 0 && this.sinceChange >= this.o.relaxAfter) {
      this.level -= 1;
      this.sinceChange = 0;
      this.durations = [];
      this.baseline = this.baseline / (1 + this.o.dwellStep);
      return {
        type: "pace",
        t,
        ...this.state,
        message:
          this.level === 0
            ? "Choosing looks easy again, so timing and target sizes are back to your settings."
            : "Choosing looks easier, so AGENCY gives you a little less extra time.",
        reason: measured,
      };
    }
    return null;
  }
}
