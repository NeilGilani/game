/**
 * A deliberate long blink as a single "switch" press, for scan-and-select.
 *
 * Ordinary blinks last roughly 100 to 400 ms. A press needs the eyes held closed for a
 * configurable time (default 450 ms) and fires once; the eyes must reopen before another
 * press can happen. Losing the face is never treated as a blink.
 */

export interface BlinkOptions {
  holdMs: number;
  closeThreshold: number;
  openThreshold: number;
  maxMs: number;
}

export interface BlinkState {
  closed: boolean;
  /** 0..1 progress towards a press while the eyes are closed. */
  progress: number;
  fired: boolean;
}

export const DEFAULT_BLINK: BlinkOptions = {
  holdMs: 450,
  closeThreshold: 0.55,
  openThreshold: 0.35,
  maxMs: 4000,
};

export class BlinkSwitch {
  private closedSince: number | null = null;
  private firedThisClosure = false;
  private options: BlinkOptions;

  constructor(options: Partial<BlinkOptions> = {}) {
    this.options = { ...DEFAULT_BLINK, ...options };
  }

  setOptions(options: Partial<BlinkOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** @param score blink score 0..1, or null when no face is visible. */
  update(timeMs: number, score: number | null): BlinkState {
    if (score === null) {
      this.closedSince = null;
      this.firedThisClosure = false;
      return { closed: false, progress: 0, fired: false };
    }
    const isClosed =
      this.closedSince !== null ? score > this.options.openThreshold : score > this.options.closeThreshold;
    if (!isClosed) {
      this.closedSince = null;
      this.firedThisClosure = false;
      return { closed: false, progress: 0, fired: false };
    }
    if (this.closedSince === null) this.closedSince = timeMs;
    const held = timeMs - this.closedSince;
    if (held > this.options.maxMs) {
      // Eyes resting, not a press. Wait for them to open.
      return { closed: true, progress: 0, fired: false };
    }
    const progress = Math.min(1, held / this.options.holdMs);
    if (progress >= 1 && !this.firedThisClosure) {
      this.firedThisClosure = true;
      return { closed: true, progress: 1, fired: true };
    }
    return { closed: true, progress: this.firedThisClosure ? 1 : progress, fired: false };
  }

  reset(): void {
    this.closedSince = null;
    this.firedThisClosure = false;
  }
}

/** Blink score from eye openness when blendshapes are unavailable (adaptive baseline). */
export class OpennessBlink {
  private baseline: number | null = null;

  score(openness: number): number {
    if (this.baseline === null) this.baseline = openness;
    // Track the open-eye baseline slowly, and only from frames that look open.
    if (openness > this.baseline * 0.7) this.baseline = this.baseline * 0.98 + openness * 0.02;
    const ratio = openness / Math.max(this.baseline, 1e-6);
    return Math.max(0, Math.min(1, (0.85 - ratio) / 0.5));
  }
}
