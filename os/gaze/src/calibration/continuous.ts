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
 * - Head movement: each selection carries the head's pose change since the scan (head.ts), and
 *   the correction includes how the offset changes with it (J). J starts at the scan's estimate and
 *   is refined jointly with the offset, pulled towards the scan's estimate as far as that was sure,
 *   so selections made leaning in or turned teach it, and an offset is not mistaken for a pose
 *   effect (or the other way round) when the pose hasn't changed.
 * - Drift that keeps landing in the same direction is corrected quietly, in bounded steps. When it
 *   is large (recent selections all off the same way by more than touchUpPt), the engine asks for a
 *   2-second touch-up (one dot, touchup.ts) instead of a full rescan; touchUp() applies it at once.
 * - Quality is tracked over time; when it falls into "poor" (or two grades below calibration)
 *   without a common direction, or soon after a touch-up, or when half of the recent selections
 *   were undone, the engine advises a clean recalibration instead of patching further.
 */

import { solve } from "../linalg";
import { HEAD_TERMS, headOffset, priorPrecision } from "./head";
import { type Grade, gradeForPoints } from "./viewing";

export interface Correction {
  /** x' = ax * [x - cx, y - cy] + bx + jx . z, around the display centre (cx, cy). */
  ax: [number, number];
  ay: [number, number];
  bx: number;
  by: number;
  /** Points per unit of head pose change z (head.ts HEAD_TERMS). */
  jx: number[];
  jy: number[];
}

const NO_HEAD = [0, 0, 0, 0, 0];
const ZERO_Z: readonly number[] = NO_HEAD;

export const IDENTITY: Correction = { ax: [1, 0], ay: [0, 1], bx: 0, by: 0, jx: NO_HEAD, jy: NO_HEAD };

/** What the scan knew about head sensitivity (HeadModel's estimate): the starting point and prior. */
export interface HeadPrior {
  jx: readonly number[];
  jy: readonly number[];
  /** Posterior precision from the scan, 5x5 row-major (head.ts). */
  precision: readonly number[];
}

/** Largest head sensitivity accepted (points per degree or cm), per term. */
const MAX_J = [20, 20, 25, 25, 12];

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
  /** Recent selections all off the same way by more than this (points): ask for a touch-up. */
  touchUpPt: number;
  /** How alike their directions must be: |mean error| / mean |error| (1 = all the same way). */
  touchUpAgreement: number;
  /** After a touch-up the offset may be this large (points); beyond it, rescan. A shift is what one
   * dot fixes well whatever its size, so this only guards against nonsense. */
  maxTouchUpPt: number;
  /** After a touch-up, poor quality within this long means rescan, not another touch-up (ms). */
  touchUpWindowMs: number;
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
  touchUpPt: 70,
  touchUpAgreement: 0.75,
  maxTouchUpPt: 500,
  touchUpWindowMs: 120_000,
};

export interface Observation {
  t: number;
  /** The model's (uncorrected) estimate, averaged over the fixation on the target. */
  x: number;
  y: number;
  /** Head pose change since the scan (head.ts headDelta); none means "same as the scan". */
  z?: readonly number[];
}

interface Confirmed {
  t: number;
  /** Uncorrected estimate. */
  x: number;
  y: number;
  /** Head pose change when it was made. */
  z: readonly number[];
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
  /** Recent selections land off the same way by about offsetPt: a 2-second touch-up will fix it. */
  | { type: "touch-up"; t: number; reason: string; offsetPt: number }
  | { type: "touched-up"; t: number; correction: Correction; shiftPt: number }
  | { type: "recalibrate"; t: number; reason: string };

export function applyCorrection(
  c: Correction,
  centre: { x: number; y: number },
  x: number,
  y: number,
  z: readonly number[] = ZERO_Z,
) {
  const dx = x - centre.x;
  const dy = y - centre.y;
  const h = headOffset(c.jx, c.jy, z);
  return {
    x: centre.x + c.ax[0] * dx + c.ax[1] * dy + c.bx + h.x,
    y: centre.y + c.ay[0] * dx + c.ay[1] * dy + c.by + h.y,
  };
}

/** Per-coordinate median of equal-length vectors. */
function medianVector(vs: readonly (readonly number[])[], length: number): number[] {
  if (vs.length === 0) return new Array<number>(length).fill(0);
  return Array.from({ length }, (_, k) => {
    const s = vs.map((v) => v[k] ?? 0).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  });
}

const GRADE_RANK: Record<Grade, number> = { good: 0, fair: 1, poor: 2 };

export class ContinuousCalibrator {
  private o: ContinuousOptions;
  private head: HeadPrior = { jx: NO_HEAD, jy: NO_HEAD, precision: priorPrecision() };
  private correction: Correction = IDENTITY;
  private touchUpAdvised = false;
  private lastTouchUp: number | null = null;
  private pending: Pending[] = [];
  private confirmed: Confirmed[] = [];
  private history: QualityPoint[] = [];
  private advised = false;
  /** Recent outcomes: true = stood, false = undone. Many undos mean the gaze lands wrong. */
  private outcomes: boolean[] = [];

  constructor(
    options: Partial<ContinuousOptions> & Pick<ContinuousOptions, "centre" | "calibratedGrade">,
    head?: HeadPrior | null,
  ) {
    this.o = { ...DEFAULT_CONTINUOUS, ...options };
    this.setHead(head ?? null);
  }

  private setHead(head: HeadPrior | null): void {
    this.head = head
      ? { jx: [...head.jx], jy: [...head.jy], precision: [...head.precision] }
      : { jx: NO_HEAD, jy: NO_HEAD, precision: priorPrecision() };
    this.correction = { ...IDENTITY, jx: [...this.head.jx], jy: [...this.head.jy] };
  }

  get current(): Correction {
    return this.correction;
  }

  get quality(): readonly QualityPoint[] {
    return this.history;
  }

  /** The corrected estimate for an uncorrected one, with the head's pose change z since the scan. */
  apply(x: number, y: number, z?: readonly number[]): { x: number; y: number } {
    return applyCorrection(this.correction, this.o.centre, x, y, z);
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
      z: medianVector(
        observations.map((o) => o.z ?? ZERO_Z),
        HEAD_TERMS.length,
      ),
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
      this.confirmed.push({ t: p.t, x: p.x, y: p.y, z: p.z, tx: p.tx, ty: p.ty, weight: p.weight });
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
      const p = applyCorrection(c, this.o.centre, q.x, q.y, q.z);
      s += q.weight * Math.hypot(p.x - q.tx, p.y - q.ty);
      w += q.weight;
    }
    return w > 0 ? s / w : 0;
  }

  /**
   * Weighted fit of the correction. With few samples an offset (most drift is a shift); with
   * slopeSamples or more, an affine map shrunk towards "no change". Both together with the head
   * terms, shrunk towards the scan's estimate of them by how sure the scan was: penalised least
   * squares, which is the Bayesian update with the scan's posterior as the prior.
   */
  private fit(samples: readonly Confirmed[]): Correction | null {
    if (samples.length < 3) return null;
    const c = this.o.centre;
    const total = samples.reduce((a, q) => a + q.weight, 0);
    if (total <= 0) return null;
    const slopes = samples.length >= this.o.slopeSamples;
    const nh = HEAD_TERMS.length;
    const ns = slopes ? 2 : 0;
    const d = 1 + ns + nh;
    // Residual noise per unit-weight selection, for weighing the prior (points).
    const spread = samples
      .map((q) => {
        const p = applyCorrection(this.correction, c, q.x, q.y, q.z);
        return Math.hypot(p.x - q.tx, p.y - q.ty) / Math.SQRT2;
      })
      .sort((a, b) => a - b);
    const sigma = Math.max(20, 1.25 * spread[Math.floor(spread.length / 2)]!);
    const pen = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    if (slopes) {
      pen[1]![1] = 0.5 * total;
      pen[2]![2] = 0.5 * total;
    }
    const s2 = sigma * sigma;
    for (let a = 0; a < nh; a++)
      for (let b = 0; b < nh; b++) pen[1 + ns + a]![1 + ns + b] = s2 * this.head.precision[a * nh + b]!;
    const solveAxis = (target: (q: Confirmed) => number, prior: readonly number[]): number[] | null => {
      const xtx = pen.map((row) => [...row]);
      const xty = new Array<number>(d).fill(0);
      // Prior mean for the head terms: penalty (beta - prior)' P (beta - prior) adds P.prior to X'y.
      for (let a = 0; a < nh; a++)
        for (let b = 0; b < nh; b++) xty[1 + ns + a]! += pen[1 + ns + a]![1 + ns + b]! * prior[b]!;
      for (const q of samples) {
        const row = [1];
        if (slopes) row.push((q.x - c.x) / 1000, (q.y - c.y) / 1000);
        for (let k = 0; k < nh; k++) row.push(q.z[k] ?? 0);
        const y = target(q);
        for (let a = 0; a < d; a++) {
          xty[a]! += q.weight * row[a]! * y;
          for (let b = 0; b < d; b++) xtx[a]![b]! += q.weight * row[a]! * row[b]!;
        }
      }
      try {
        return solve(xtx, xty);
      } catch {
        return null;
      }
    };
    const rx = solveAxis((q) => q.tx - q.x, this.head.jx);
    const ry = solveAxis((q) => q.ty - q.y, this.head.jy);
    if (!rx || !ry) return null;
    return {
      ax: slopes ? [1 + rx[1]! / 1000, rx[2]! / 1000] : [1, 0],
      ay: slopes ? [ry[1]! / 1000, 1 + ry[2]! / 1000] : [0, 1],
      bx: rx[0]!,
      by: ry[0]!,
      jx: rx.slice(1 + ns),
      jy: ry.slice(1 + ns),
    };
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
    const j = (v: readonly number[]) => v.map((x, k) => clamp(x, -MAX_J[k]!, MAX_J[k]!));
    return {
      ax: [clamp(next.ax[0], 1 - s, 1 + s), clamp(next.ax[1], -s, s)],
      ay: [clamp(next.ay[0], -s, s), clamp(next.ay[1], 1 - s, 1 + s)],
      bx,
      by,
      jx: j(next.jx),
      jy: j(next.jy),
    };
  }

  /**
   * Drop selections that look like mistakes nobody undid (the estimate was far from the target
   * compared with the others): someone who can't easily undo shouldn't teach the model wrongly.
   */
  private plausible(): Confirmed[] {
    const r = this.confirmed.map((q) => {
      const p = applyCorrection(this.correction, this.o.centre, q.x, q.y, q.z);
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
      const p = applyCorrection(c, this.o.centre, q.x, q.y, q.z);
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
    const drift = this.drift(recent);
    const recentTouchUp = this.lastTouchUp !== null && t - this.lastTouchUp < this.o.touchUpWindowMs;
    if (
      !this.touchUpAdvised &&
      !this.advised &&
      !recentTouchUp &&
      recent.length >= 4 &&
      drift.offsetPt >= this.o.touchUpPt &&
      drift.agreement >= this.o.touchUpAgreement
    ) {
      this.touchUpAdvised = true;
      events.push({
        type: "touch-up",
        t,
        offsetPt: drift.offsetPt,
        reason: `Recent choices all landed about ${Math.round(drift.offsetPt)} points off in the same direction.`,
      });
      return events;
    }
    const dropped = GRADE_RANK[point.grade] - GRADE_RANK[this.o.calibratedGrade] >= 2;
    const sinceTouchUp =
      this.lastTouchUp === null ? Infinity : recent.filter((q) => q.t > this.lastTouchUp!).length;
    // A touch-up needs a few selections to show whether it worked; one that didn't means rescan.
    const waiting = this.touchUpAdvised || (recentTouchUp && sinceTouchUp < 4);
    if (!this.advised && !waiting && recent.length >= 5 && (point.grade === "poor" || dropped)) {
      this.advised = true;
      events.push({
        type: "recalibrate",
        t,
        reason: recentTouchUp
          ? `The touch-up didn't hold: recent selections were still about ${Math.round(errorPt)} points off.`
          : `Eye control has drifted: recent selections were about ${Math.round(errorPt)} points off.`,
      });
    }
    return events;
  }

  /** Weighted mean error vector of recent selections under the current correction, and how alike their directions are. */
  private drift(recent: readonly Confirmed[]): { x: number; y: number; offsetPt: number; agreement: number } {
    let sx = 0;
    let sy = 0;
    let len = 0;
    let w = 0;
    for (const q of recent) {
      const p = applyCorrection(this.correction, this.o.centre, q.x, q.y, q.z);
      const ex = q.tx - p.x;
      const ey = q.ty - p.y;
      sx += q.weight * ex;
      sy += q.weight * ey;
      len += q.weight * Math.hypot(ex, ey);
      w += q.weight;
    }
    if (w <= 0) return { x: 0, y: 0, offsetPt: 0, agreement: 0 };
    const offsetPt = Math.hypot(sx / w, sy / w);
    return { x: sx / w, y: sy / w, offsetPt, agreement: len > 0 ? (offsetPt * w) / len : 0 };
  }

  /**
   * The person looked at a touch-up dot at `target`: the uncorrected estimate there was `estimate`
   * (median over the dot), with head pose change z. Moves the offset so the dot is hit, keeping the
   * slope and head terms, and starts learning afresh from here (older selections describe how
   * things were before the drift). Returns the events: "touched-up", or "recalibrate" when the
   * shift needed is beyond what a touch-up should fix.
   */
  touchUp(
    t: number,
    target: { x: number; y: number },
    estimate: { x: number; y: number },
    z: readonly number[] = ZERO_Z,
  ): ContinuousEvent[] {
    this.touchUpAdvised = false;
    const c = this.correction;
    const now = applyCorrection(c, this.o.centre, estimate.x, estimate.y, z);
    const bx = c.bx + (target.x - now.x);
    const by = c.by + (target.y - now.y);
    if (Math.hypot(bx, by) > this.o.maxTouchUpPt) {
      this.advised = true;
      return [
        {
          type: "recalibrate",
          t,
          reason: `Eye control is too far off for a touch-up (about ${Math.round(Math.hypot(target.x - now.x, target.y - now.y))} points): a fresh scan will do better.`,
        },
      ];
    }
    this.correction = { ...c, bx, by };
    this.lastTouchUp = t;
    this.confirmed = [{ t, x: estimate.x, y: estimate.y, z: [...z], tx: target.x, ty: target.y, weight: 2 }];
    this.pending = [];
    this.history = [];
    return [
      {
        type: "touched-up",
        t,
        correction: this.correction,
        shiftPt: Math.hypot(target.x - now.x, target.y - now.y),
      },
    ];
  }

  /** Start again from the calibrated model (after a fresh calibration), with its head estimate. */
  reset(calibratedGrade: Grade, centre = this.o.centre, head: HeadPrior | null = null): void {
    this.o = { ...this.o, calibratedGrade, centre };
    this.setHead(head);
    this.touchUpAdvised = false;
    this.lastTouchUp = null;
    this.pending = [];
    this.confirmed = [];
    this.history = [];
    this.outcomes = [];
    this.advised = false;
  }
}
