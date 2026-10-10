/**
 * Continuous recalibration from everyday use.
 *
 * When a dwell selects a known target and the person doesn't undo it within a few seconds, we
 * know (roughly) where they were looking: at that target. Each such confirmed selection becomes
 * a weighted sample. The samples fit a small correction on top of the calibrated model: an
 * affine map that starts as "no change" and is pulled only as far as the evidence supports. It
 * mostly absorbs drift (the head settling lower in the chair, the laptop lid moved).
 *
 * Rules, all tested:
 * - Only small targets teach precisely; big ones get little weight, very big ones none.
 * - A selection that is undone within confirmMs is discarded, never learned.
 * - Each update is bounded (maxStepPt per update, maxTotalPt overall, slope within maxSlope).
 * - Never silently make things worse: an update is applied only if its leave-one-out error on
 *   the recent confirmed selections beats the current correction's error on the same ones.
 * - Quality is tracked over time; when it falls into "poor" (or two grades below calibration),
 *   or when half of the recent selections were undone, the engine advises a clean
 *   recalibration instead of patching further.
 */

import { ridge } from "../linalg";
import { type Grade, gradeForPoints } from "./viewing";

export interface Correction {
  /** x' = ax * [x - cx, y - cy] + bx, around the display centre (cx, cy). */
  ax: [number, number];
  ay: [number, number];
  bx: number;
  by: number;
}

export const IDENTITY: Correction = { ax: [1, 0], ay: [0, 1], bx: 0, by: 0 };

export interface ContinuousOptions {
  /** Centre of the calibrated display (global points). */
  centre: { x: number; y: number };
  confirmMs: number;
  /** Targets larger than this (points, either side) teach nothing. */
  maxTargetPt: number;
  /** A target this size or smaller gets full weight. */
  fullWeightTargetPt: number;
  maxStepPt: number;
  maxTotalPt: number;
  /** Largest change of scale/shear allowed, e.g. 0.12 = 12 %. */
  maxSlope: number;
  /** Recent confirmed selections kept for fitting and checking. */
  memory: number;
  /** Minimum confirmed selections before any correction is tried. */
  minSamples: number;
  /** Below this many, only an offset is learned (scale and shear need much more evidence). */
  slopeSamples: number;
  /** Grade the calibration had when it was made. */
  calibratedGrade: Grade;
}

export const DEFAULT_CONTINUOUS: Omit<ContinuousOptions, "centre" | "calibratedGrade"> = {
  confirmMs: 4000,
  maxTargetPt: 360,
  fullWeightTargetPt: 120,
  maxStepPt: 25,
  maxTotalPt: 160,
  maxSlope: 0.12,
  memory: 30,
  minSamples: 4,
  slopeSamples: 20,
};

export interface Observation {
  t: number;
  /** The model's (uncorrected) estimate, averaged over the fixation on the target. */
  x: number;
  y: number;
}

interface Confirmed {
  t: number;
  /** Uncorrected estimate. */
  x: number;
  y: number;
  /** Target centre. */
  tx: number;
  ty: number;
  weight: number;
}

interface Pending extends Confirmed {
  id: string;
}

export interface QualityPoint {
  t: number;
  /** Rolling mean error of corrected estimates on recent confirmed selections (points). */
  errorPt: number;
  grade: Grade;
  samples: number;
}

export type ContinuousEvent =
  | { type: "learned"; t: number; weight: number }
  | { type: "discarded"; t: number; reason: "undone" | "too-big" | "too-few-frames" }
  | { type: "updated"; t: number; correction: Correction; before: number; after: number }
  | { type: "rejected-update"; t: number; before: number; after: number }
  | { type: "quality"; point: QualityPoint }
  | { type: "recalibrate"; t: number; reason: string };

export function applyCorrection(c: Correction, centre: { x: number; y: number }, x: number, y: number) {
  const dx = x - centre.x;
  const dy = y - centre.y;
  return {
    x: centre.x + c.ax[0] * dx + c.ax[1] * dy + c.bx,
    y: centre.y + c.ay[0] * dx + c.ay[1] * dy + c.by,
  };
}

const GRADE_RANK: Record<Grade, number> = { good: 0, fair: 1, poor: 2 };

export class ContinuousCalibrator {
  private o: ContinuousOptions;
  private correction: Correction = IDENTITY;
  private pending: Pending[] = [];
  private confirmed: Confirmed[] = [];
  private history: QualityPoint[] = [];
  private advised = false;
  /** Recent outcomes: true = stood, false = undone. Many undos mean the gaze lands wrong. */
  private outcomes: boolean[] = [];

  constructor(options: Partial<ContinuousOptions> & Pick<ContinuousOptions, "centre" | "calibratedGrade">) {
    this.o = { ...DEFAULT_CONTINUOUS, ...options };
  }

  get current(): Correction {
    return this.correction;
  }

  get quality(): readonly QualityPoint[] {
    return this.history;
  }

  apply(x: number, y: number): { x: number; y: number } {
    return applyCorrection(this.correction, this.o.centre, x, y);
  }

  /**
   * A dwell selected a target. `observations` are the uncorrected estimates from the fixation
   * that selected it (the engine passes the frames between dwell start and activation).
   */
  selected(
    id: string,
    t: number,
    rect: { x: number; y: number; width: number; height: number },
    observations: readonly Observation[],
  ): ContinuousEvent[] {
    const size = Math.max(rect.width, rect.height);
    if (size > this.o.maxTargetPt) return [{ type: "discarded", t, reason: "too-big" }];
    if (observations.length < 6) return [{ type: "discarded", t, reason: "too-few-frames" }];
    // Median of the fixation's estimates: robust to the frames at the start of the dwell.
    const xs = observations.map((o) => o.x).sort((a, b) => a - b);
    const ys = observations.map((o) => o.y).sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    const weight = Math.min(1, this.o.fullWeightTargetPt / Math.max(size, 1));
    this.pending.push({
      id,
      t,
      x: xs[mid]!,
      y: ys[mid]!,
      tx: rect.x + rect.width / 2,
      ty: rect.y + rect.height / 2,
      weight,
    });
    return [];
  }

  /** The person undid a selection (Back, Undo, Cancel): don't learn from it. */
  undone(id: string, t: number): ContinuousEvent[] {
    const before = this.pending.length;
    this.pending = this.pending.filter((p) => !(p.id === id && t - p.t <= this.o.confirmMs));
    if (before === this.pending.length) return [];
    const events: ContinuousEvent[] = [{ type: "discarded", t, reason: "undone" }];
    this.outcomes.push(false);
    if (this.outcomes.length > 10) this.outcomes.shift();
    const undone = this.outcomes.filter((o) => !o).length;
    if (!this.advised && this.outcomes.length >= 6 && undone / this.outcomes.length >= 0.5) {
      this.advised = true;
      events.push({
        type: "recalibrate",
        t,
        reason: `Eye control keeps choosing the wrong thing: ${undone} of the last ${this.outcomes.length} choices were undone.`,
      });
    }
    return events;
  }

  /** Call regularly (each frame is fine). Confirms selections that stood for confirmMs. */
  tick(t: number): ContinuousEvent[] {
    const events: ContinuousEvent[] = [];
    const ready = this.pending.filter((p) => t - p.t >= this.o.confirmMs);
    if (ready.length === 0) return events;
    this.pending = this.pending.filter((p) => t - p.t < this.o.confirmMs);
    for (const p of ready) {
      this.outcomes.push(true);
      if (this.outcomes.length > 10) this.outcomes.shift();
      this.confirmed.push({ t: p.t, x: p.x, y: p.y, tx: p.tx, ty: p.ty, weight: p.weight });
      events.push({ type: "learned", t, weight: p.weight });
    }
    while (this.confirmed.length > this.o.memory) this.confirmed.shift();
    events.push(...this.maybeUpdate(t));
    events.push(...this.trackQuality(t));
    return events;
  }

  private errorWith(c: Correction, samples: readonly Confirmed[]): number {
    let s = 0;
    let w = 0;
    for (const q of samples) {
      const p = applyCorrection(c, this.o.centre, q.x, q.y);
      s += q.weight * Math.hypot(p.x - q.tx, p.y - q.ty);
      w += q.weight;
    }
    return w > 0 ? s / w : 0;
  }

  /**
   * Weighted fit of the correction. With few samples only an offset (two numbers: most drift is
   * a shift); with slopeSamples or more, an affine map shrunk towards "no change".
   */
  private fit(samples: readonly Confirmed[]): Correction | null {
    if (samples.length < 3) return null;
    const c = this.o.centre;
    const w = samples.map((q) => q.weight);
    if (samples.length < this.o.slopeSamples) {
      const total = w.reduce((a, b) => a + b, 0);
      if (total <= 0) return null;
      const bx = samples.reduce((a, q, i) => a + w[i]! * (q.tx - q.x), 0) / total;
      const by = samples.reduce((a, q, i) => a + w[i]! * (q.ty - q.y), 0) / total;
      return { ax: [1, 0], ay: [0, 1], bx, by };
    }
    // Design: [1, dx/1000, dy/1000]; target is the residual (target - estimate).
    const rows = samples.map((q) => [1, (q.x - c.x) / 1000, (q.y - c.y) / 1000]);
    try {
      const rx = ridge(
        rows,
        samples.map((q) => q.tx - q.x),
        0.5,
        w,
      );
      const ry = ridge(
        rows,
        samples.map((q) => q.ty - q.y),
        0.5,
        w,
      );
      return {
        ax: [1 + rx[1]! / 1000, rx[2]! / 1000],
        ay: [ry[1]! / 1000, 1 + ry[2]! / 1000],
        bx: rx[0]!,
        by: ry[0]!,
      };
    } catch {
      return null;
    }
  }

  /** Limit how far one update can move things from the current correction. */
  private bound(next: Correction): Correction {
    const cur = this.correction;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const step = (a: number, b: number) => clamp(b, a - this.o.maxStepPt, a + this.o.maxStepPt);
    let bx = step(cur.bx, next.bx);
    let by = step(cur.by, next.by);
    const total = Math.hypot(bx, by);
    if (total > this.o.maxTotalPt) {
      bx *= this.o.maxTotalPt / total;
      by *= this.o.maxTotalPt / total;
    }
    const s = this.o.maxSlope;
    return {
      ax: [clamp(next.ax[0], 1 - s, 1 + s), clamp(next.ax[1], -s, s)],
      ay: [clamp(next.ay[0], -s, s), clamp(next.ay[1], 1 - s, 1 + s)],
      bx,
      by,
    };
  }

  /**
   * Drop selections that look like mistakes nobody undid (the estimate was far from the target
   * compared with the others): someone who can't easily undo shouldn't teach the model wrongly.
   */
  private plausible(): Confirmed[] {
    const r = this.confirmed.map((q) => {
      const p = applyCorrection(this.correction, this.o.centre, q.x, q.y);
      return Math.hypot(p.x - q.tx, p.y - q.ty);
    });
    const sorted = [...r].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const limit = Math.max(3 * med, 150);
    return this.confirmed.filter((_, i) => r[i]! <= limit);
  }

  private maybeUpdate(t: number): ContinuousEvent[] {
    const samples = this.plausible();
    if (samples.length < this.o.minSamples) return [];
    const candidate = this.fit(samples);
    if (!candidate) return [];
    const proposed = this.bound(candidate);
    // Leave-one-out: how well would this kind of update predict selections it didn't see?
    let looSum = 0;
    let looW = 0;
    for (let i = 0; i < samples.length; i++) {
      const rest = samples.filter((_, j) => j !== i);
      const fit = this.fit(rest);
      if (!fit) return [];
      const c = this.bound(fit);
      const q = samples[i]!;
      const p = applyCorrection(c, this.o.centre, q.x, q.y);
      looSum += q.weight * Math.hypot(p.x - q.tx, p.y - q.ty);
      looW += q.weight;
    }
    const after = looSum / looW;
    const before = this.errorWith(this.correction, samples);
    if (after < before) {
      this.correction = proposed;
      return [{ type: "updated", t, correction: proposed, before, after }];
    }
    return [{ type: "rejected-update", t, before, after }];
  }

  private trackQuality(t: number): ContinuousEvent[] {
    const recent = this.confirmed.slice(-8);
    if (recent.length < 3) return [];
    const errorPt = this.errorWith(this.correction, recent);
    const point: QualityPoint = { t, errorPt, grade: gradeForPoints(errorPt), samples: recent.length };
    this.history.push(point);
    if (this.history.length > 500) this.history.shift();
    const events: ContinuousEvent[] = [{ type: "quality", point }];
    const dropped = GRADE_RANK[point.grade] - GRADE_RANK[this.o.calibratedGrade] >= 2;
    if (!this.advised && recent.length >= 5 && (point.grade === "poor" || dropped)) {
      this.advised = true;
      events.push({
        type: "recalibrate",
        t,
        reason: `Eye control has drifted: recent selections were about ${Math.round(errorPt)} points off.`,
      });
    }
    return events;
  }

  /** Start again from the calibrated model (after a fresh calibration). */
  reset(calibratedGrade: Grade, centre = this.o.centre): void {
    this.o = { ...this.o, calibratedGrade, centre };
    this.correction = IDENTITY;
    this.pending = [];
    this.confirmed = [];
    this.history = [];
    this.outcomes = [];
    this.advised = false;
  }
}
