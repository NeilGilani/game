/**
 * The eye help signal: three long blinks.
 *
 * Someone who can't move or speak can still close their eyes on purpose. One long blink is
 * easy to do by accident (resting, drowsiness), so the signal is three deliberate closures,
 * each held for about a second, inside ten seconds. Ordinary blinks (under ~0.4 s) are
 * ignored and don't break the pattern. Eyes kept closed for longer (resting, sleep) reset it,
 * and so does losing the face, which is never read as a closed eye.
 *
 * Firing only opens Lifeline's countdown; nothing is sent until the cancel window passes.
 */

export interface PatternOptions {
  /** Shortest closure that counts (ms). */
  minMs: number;
  /** Longest closure that counts; longer means resting and resets the pattern (ms). */
  maxMs: number;
  /** Closures needed. */
  count: number;
  /** All counted closures must start within this window (ms). */
  windowMs: number;
  /** After firing, ignore the eyes for this long (ms). */
  refractoryMs: number;
  /** Blink score above which the eyes count as closed (and below which they reopen). */
  closeThreshold: number;
  openThreshold: number;
}

export const DEFAULT_PATTERN: PatternOptions = {
  minMs: 600,
  maxMs: 2500,
  count: 3,
  windowMs: 10000,
  refractoryMs: 6000,
  closeThreshold: 0.55,
  openThreshold: 0.35,
};

export interface PatternState {
  /** Long blinks counted so far (0 when idle). */
  counted: number;
  /** True while the eyes are closed. */
  closed: boolean;
  /** 0..1 progress of the current closure towards counting. */
  holdProgress: number;
  /** True on the single update where the full pattern completed. */
  fired: boolean;
}

const IDLE: PatternState = { counted: 0, closed: false, holdProgress: 0, fired: false };

export class HelpPattern {
  private options: PatternOptions;
  private closedSince: number | null = null;
  private starts: number[] = [];
  private refractoryUntil = -Infinity;

  constructor(options: Partial<PatternOptions> = {}) {
    this.options = { ...DEFAULT_PATTERN, ...options };
  }

  /** @param score blink score 0..1, or null when no face is visible. */
  update(t: number, score: number | null): PatternState {
    const o = this.options;
    if (t < this.refractoryUntil) {
      this.closedSince = null;
      return IDLE;
    }
    if (score === null) {
      this.reset();
      return IDLE;
    }
    this.starts = this.starts.filter((s) => t - s <= o.windowMs);
    const closed = this.closedSince !== null ? score > o.openThreshold : score > o.closeThreshold;

    if (closed) {
      this.closedSince ??= t;
      const held = t - this.closedSince;
      if (held > o.maxMs) {
        // Resting or asleep, not signalling.
        this.starts = [];
        return { counted: 0, closed: true, holdProgress: 0, fired: false };
      }
      return {
        counted: this.starts.length,
        closed: true,
        holdProgress: Math.min(1, held / o.minMs),
        fired: false,
      };
    }

    if (this.closedSince !== null) {
      const start = this.closedSince;
      const held = t - start;
      this.closedSince = null;
      if (held >= o.minMs && held <= o.maxMs) {
        this.starts.push(start);
        if (this.starts.length >= o.count) {
          this.starts = [];
          this.refractoryUntil = t + o.refractoryMs;
          return { counted: o.count, closed: false, holdProgress: 0, fired: true };
        }
      }
    }
    return { counted: this.starts.length, closed: false, holdProgress: 0, fired: false };
  }

  reset(): void {
    this.closedSince = null;
    this.starts = [];
  }
}
