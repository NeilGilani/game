/**
 * Dwell selection: a target is selected when the pointer (gaze or head) rests on it long
 * enough, steadily enough, with good tracking.
 *
 * Safety rules, all covered by tests/dwell.test.ts:
 * - Progress only accumulates while tracking confidence is good and the pointer is steady.
 * - Brief excursions (a saccade, a blink, a glance away) pause progress instead of resetting it;
 *   it resumes where it was if the pointer is back within the grace period.
 * - After a selection, nothing can be selected for a refractory period, and the selected
 *   target cannot fire again until the pointer has left it.
 * - Losing tracking for longer than the grace period cancels the dwell.
 */

export interface DwellConfig {
  dwellMs: number;
  /** Max spread (px) of recent pointer positions for progress to count. */
  stabilityPx: number;
  /** Window (ms) over which stability is measured. */
  stabilityWindowMs: number;
  /** Off-target or low-confidence time (ms) tolerated before the dwell resets. */
  graceMs: number;
  /** No selection of any target for this long after a selection (ms). */
  refractoryMs: number;
  minConfidence: number;
}

export const DEFAULT_DWELL: DwellConfig = {
  dwellMs: 1200,
  stabilityPx: 60,
  stabilityWindowMs: 300,
  graceMs: 300,
  refractoryMs: 900,
  minConfidence: 0.5,
};

export interface DwellSample {
  t: number;
  x: number;
  y: number;
  confidence: number;
  /** Target under (or snapped to) the pointer, if any. */
  targetId: string | null;
  /** Some targets ask for a longer dwell (e.g. resuming eye control). */
  dwellScale?: number;
  /**
   * How much this frame counts towards the dwell, 0..1 (default 1). Target magnetism passes 0 while
   * the lock holds on a target the estimate no longer supports (a glance away, a wobble towards a
   * neighbour): progress pauses there instead of completing on evidence that doesn't support it.
   * A frame with weight 0 doesn't count towards steadiness either, so progress resumes as soon as
   * the eyes are back.
   */
  weight?: number;
}

export type DwellEvent =
  | { type: "enter"; targetId: string }
  | { type: "progress"; targetId: string; progress: number }
  | { type: "activate"; targetId: string }
  | { type: "cancel"; targetId: string; reason: "left" | "tracking-lost" }
  | { type: "blocked"; targetId: string; reason: "refractory" | "spent" };

export interface DwellSnapshot {
  targetId: string | null;
  progress: number;
  stable: boolean;
}

export class DwellEngine {
  private config: DwellConfig;
  private current: string | null = null;
  private accumulated = 0;
  private lastT: number | null = null;
  private awaySince: number | null = null;
  private spent: string | null = null;
  private refractoryUntil = 0;
  private recent: { t: number; x: number; y: number }[] = [];
  private stable = false;

  constructor(config: Partial<DwellConfig> = {}) {
    this.config = { ...DEFAULT_DWELL, ...config };
  }

  setConfig(config: Partial<DwellConfig>): void {
    this.config = { ...this.config, ...config };
  }

  snapshot(): DwellSnapshot {
    return {
      targetId: this.current,
      progress: this.current ? Math.min(1, this.accumulated / this.config.dwellMs) : 0,
      stable: this.stable,
    };
  }

  /** Forget the current dwell and block selection briefly (e.g. after navigation). */
  reset(now: number, holdMs = this.config.refractoryMs): void {
    this.current = null;
    this.accumulated = 0;
    this.awaySince = null;
    this.recent = [];
    this.lastT = now;
    this.refractoryUntil = Math.max(this.refractoryUntil, now + holdMs);
  }

  private measureStability(sample: DwellSample): boolean {
    this.recent.push({ t: sample.t, x: sample.x, y: sample.y });
    const cutoff = sample.t - this.config.stabilityWindowMs;
    this.recent = this.recent.filter((p) => p.t >= cutoff);
    const mx = this.recent.reduce((s, p) => s + p.x, 0) / this.recent.length;
    const my = this.recent.reduce((s, p) => s + p.y, 0) / this.recent.length;
    const spread = Math.max(...this.recent.map((p) => Math.hypot(p.x - mx, p.y - my)));
    return spread <= this.config.stabilityPx;
  }

  update(sample: DwellSample): DwellEvent[] {
    const events: DwellEvent[] = [];
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(sample.t - this.lastT, 100));
    this.lastT = sample.t;

    const good = sample.confidence >= this.config.minConfidence;
    if (this.spent && sample.targetId !== this.spent && good) {
      this.spent = null; // left the selected target: it may be selected again later
    }

    if (!good || sample.targetId === null || sample.targetId !== this.current) {
      // Away from the current target (or tracking is poor): pause, then cancel after grace.
      if (this.current !== null) {
        if (this.awaySince === null) this.awaySince = sample.t;
        if (sample.t - this.awaySince > this.config.graceMs) {
          events.push({ type: "cancel", targetId: this.current, reason: good ? "left" : "tracking-lost" });
          this.current = null;
          this.accumulated = 0;
          this.awaySince = null;
          this.recent = [];
        }
      }
      if (this.current === null && good && sample.targetId !== null) {
        this.current = sample.targetId;
        this.accumulated = 0;
        this.awaySince = null;
        this.recent = [];
        events.push({ type: "enter", targetId: sample.targetId });
      }
      if (!good || sample.targetId !== this.current) {
        this.stable = false;
        return events;
      }
    }

    this.awaySince = null;
    const target = this.current;
    if (target === null) return events;
    const weight = Math.max(0, Math.min(1, sample.weight ?? 1));
    if (weight > 0) this.stable = this.measureStability(sample);

    if (target === this.spent) {
      events.push({ type: "blocked", targetId: target, reason: "spent" });
      return events;
    }
    if (sample.t < this.refractoryUntil) {
      events.push({ type: "blocked", targetId: target, reason: "refractory" });
      return events;
    }
    if (this.stable) this.accumulated += dt * weight;
    const needed = this.config.dwellMs * (sample.dwellScale ?? 1);
    const progress = Math.min(1, this.accumulated / needed);
    events.push({ type: "progress", targetId: target, progress });
    if (this.accumulated >= needed) {
      events.push({ type: "activate", targetId: target });
      this.spent = target;
      this.accumulated = 0;
      this.refractoryUntil = sample.t + this.config.refractoryMs;
    }
    return events;
  }
}
