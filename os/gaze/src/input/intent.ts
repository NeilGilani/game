/**
 * Intent: which target the person means, from where the eyes are AND what is likely on this screen.
 *
 *   P(target | gaze) ∝ P(gaze | target) × P(target | context)
 *
 * - Gaze likelihood: the estimate lands within about errorRadius (two standard deviations) of where
 *   the person really looks, so P(gaze | target) = exp(-d² / 2σ²) with σ = errorRadius / 2 and d the
 *   distance from the estimate to the target (0 inside it).
 * - Context prior: a weight per target from the screen and the task (the agent is waiting for an
 *   answer, the next empty field, the person's usual). 1 is neutral. Priors are clamped to a small
 *   range (priorMin..priorMax) so they can only settle what the tracker can't tell apart: with sharp
 *   tracking σ is small and the eyes decide; with rough tracking the context counts for more.
 * - "Nothing": the person may be reading or resting. It wins when every target is further than the
 *   snap distance (as plain hit-testing does), so a prior widens a likely target's reach only a
 *   little, and never beyond maxReachPx.
 *
 * With strength 0 (or every prior 1) chooseTarget is exactly findTarget: the snap the app used before.
 *
 * Approval gates (Approve, Confirm, Sign) never get more than a neutral prior: the context must never
 * pull the eyes towards the step that guards a payment, a message or a share. Protected targets (Stop,
 * Help, Lifeline) always get the highest prior on the screen, so context never makes them harder.
 *
 * Prediction (HeadingPredictor): when the pointer is moving towards a likely target, that target is
 * pre-highlighted, and if the eyes then land on it its dwell may be a little shorter. Never for a
 * consequential target (pays, sends, shares, signs, calls, deletes): those keep the full dwell and
 * still go through the approval flow.
 *
 * Adaptive layout (PrecisionMeter): rough tracking makes likely targets bigger and spaces things out;
 * sharp tracking allows denser screens. The level moves slowly and with hysteresis, and the app only
 * applies it when the screen changes, so nothing moves under the person's eyes.
 *
 * Everything here is pure and deterministic, runs on the device, and sees only pointer coordinates
 * and target rectangles: no video, no images, nothing sent anywhere.
 */

import { type DwellConfig, DwellEngine, type DwellEvent } from "./dwell";
import { type TargetRect, distanceToRect } from "./targets";

export interface IntentTarget extends TargetRect {
  /** Context prior, 1 = neutral (clamped to priorMin..priorMax). */
  prior?: number;
  /** Pays, sends, shares, signs, calls or deletes: never predicted, never a shorter dwell. */
  consequential?: boolean;
  /** Grants an approval (Approve, Confirm, Sign): never more than a neutral prior. */
  gate?: boolean;
  /**
   * Stop, Help, Lifeline, Pause: never on the losing side of a prior. Their prior is raised to the
   * highest prior among the targets, so context can never make it harder to stop or to call for help.
   */
  protect?: boolean;
}

export interface IntentOptions {
  /** Plain reach (px beyond a target's edge) with a neutral prior: the snap distance. */
  snapPx: number;
  /** Hard limit on reach, whatever the prior and the tracking. */
  maxReachPx: number;
  /** Smallest σ (px), so a tracker that claims to be perfect still leaves the prior a little room. */
  minSigmaPx: number;
  priorMin: number;
  priorMax: number;
  /** How much the context counts, 0 (off: plain snap) to 1 (full Bayes). */
  strength: number;
}

export const DEFAULT_INTENT: IntentOptions = {
  snapPx: 48,
  maxReachPx: 96,
  minSigmaPx: 8,
  priorMin: 0.5,
  priorMax: 3,
  strength: 1,
};

/** A target's effective prior: clamped, gates never above neutral, scaled by strength. */
export function effectivePrior(t: IntentTarget, o: IntentOptions = DEFAULT_INTENT): number {
  let p = t.prior ?? 1;
  if (!Number.isFinite(p) || p <= 0) p = 1;
  p = Math.max(o.priorMin, Math.min(o.priorMax, p));
  if (t.gate) p = Math.min(1, p);
  return Math.pow(p, Math.max(0, Math.min(1, o.strength)));
}

/** Priors for a list of targets: effectivePrior, with protected targets raised to the highest one. */
export function priorsOf(targets: readonly IntentTarget[], o: IntentOptions = DEFAULT_INTENT): number[] {
  const own = targets.map((t) => effectivePrior(t, o));
  const top = Math.max(1, ...own);
  return targets.map((t, i) => (t.protect ? top : own[i]!));
}

/** σ of the gaze estimate (px) from the engine's error radius (about 2σ). */
export function gazeSigma(errorRadius: number, o: IntentOptions = DEFAULT_INTENT): number {
  return Math.max(o.minSigmaPx, (Number.isFinite(errorRadius) ? errorRadius : 0) / 2);
}

export interface Hypothesis {
  /** null: the person isn't looking at any target. */
  id: string | null;
  /** Posterior probability. */
  p: number;
  /** Distance from the estimate to the target (px); the snap distance for "nothing". */
  distance: number;
}

/**
 * Posterior over the targets and "nothing", most probable first. Targets beyond maxReachPx are
 * left out (probability 0). Ties go to the smaller target, as findTarget does.
 */
export function posterior(
  x: number,
  y: number,
  errorRadius: number,
  targets: readonly IntentTarget[],
  options: Partial<IntentOptions> = {},
): Hypothesis[] {
  const o = { ...DEFAULT_INTENT, ...options };
  const sigma = gazeSigma(errorRadius, o);
  const twoS2 = 2 * sigma * sigma;
  const reach = Math.max(0, o.snapPx);
  const cap = Math.max(reach, o.maxReachPx);
  // Log scores; "nothing" scores like a neutral target exactly at the snap distance.
  const scored: { id: string | null; log: number; distance: number; area: number }[] = [
    { id: null, log: -(reach * reach) / twoS2, distance: reach, area: Infinity },
  ];
  const priors = priorsOf(targets, o);
  targets.forEach((t, i) => {
    const d = distanceToRect(x, y, t.rect);
    if (d > cap) return;
    const area = (t.rect.right - t.rect.left) * (t.rect.bottom - t.rect.top);
    scored.push({ id: t.id, log: Math.log(priors[i]!) - (d * d) / twoS2, distance: d, area });
  });
  const top = Math.max(...scored.map((s) => s.log));
  const weights = scored.map((s) => Math.exp(s.log - top));
  const sum = weights.reduce((a, b) => a + b, 0);
  return scored
    .map((s, i) => ({ id: s.id, p: weights[i]! / sum, distance: s.distance, area: s.area }))
    .sort((a, b) => b.p - a.p || a.area - b.area)
    .map(({ id, p, distance }) => ({ id, p, distance }));
}

/**
 * The target the person most probably means, or null. A target beats "nothing" only if it is within
 * the snap distance or its prior makes up for the extra distance (and never beyond maxReachPx). With
 * neutral priors this is findTarget(x, y, targets, snapPx).
 */
export function chooseTarget(
  x: number,
  y: number,
  errorRadius: number,
  targets: readonly IntentTarget[],
  options: Partial<IntentOptions> = {},
): string | null {
  const o = { ...DEFAULT_INTENT, ...options };
  const reach = Math.max(0, o.snapPx);
  const sigma = gazeSigma(errorRadius, o);
  const twoS2 = 2 * sigma * sigma;
  const priors = priorsOf(targets, o);
  let best: { id: string; log: number; area: number } | null = null;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const d = distanceToRect(x, y, t.rect);
    if (d > Math.max(reach, o.maxReachPx)) continue;
    const log = Math.log(priors[i]!) - (d * d) / twoS2;
    // A neutral target exactly at the snap distance still counts (findTarget's d <= snapPx).
    if (log < -(reach * reach) / twoS2) continue;
    const area = (t.rect.right - t.rect.left) * (t.rect.bottom - t.rect.top);
    if (!best || log > best.log + 1e-12 || (Math.abs(log - best.log) <= 1e-12 && area < best.area)) {
      best = { id: t.id, log, area };
    }
  }
  return best?.id ?? null;
}

// --- Prediction ------------------------------------------------------------------------------

export interface PredictOptions {
  /** Movement is measured over this much of the recent pointer track (ms). */
  windowMs: number;
  /** Slower than this (px/s) isn't heading anywhere. */
  minSpeedPxS: number;
  /**
   * And it must have moved at least this far within the window (px). 60, 150 and 300 px did about the
   * same in bench/intent.bench.ts; 150 is above a reading saccade (70 to 130 px).
   */
  minTravelPx: number;
  /** The target must lie within this angle of the direction of travel (degrees). */
  maxAngleDeg: number;
  /** Only targets at least this likely are predicted (effective prior). */
  minPrior: number;
  /** Targets further ahead than this aren't predicted (px). */
  maxDistancePx: number;
  /** A prediction lasts this long after the movement that made it (ms), so it survives the arrival. */
  holdMs: number;
  /** Dwell scale for a predicted arrival (0.75: 1200 ms becomes 900 ms). Never below 0.5. */
  dwellScale: number;
  minConfidence: number;
}

export const DEFAULT_PREDICT: PredictOptions = {
  windowMs: 200,
  minSpeedPxS: 600,
  minTravelPx: 150,
  maxAngleDeg: 20,
  minPrior: 1.5,
  maxDistancePx: 900,
  holdMs: 500,
  dwellScale: 0.75,
  minConfidence: 0.5,
};

function angleTo(vx: number, vy: number, tx: number, ty: number): number {
  const n = Math.hypot(vx, vy) * Math.hypot(tx, ty);
  if (n === 0) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, (vx * tx + vy * ty) / n))) * 180) / Math.PI;
}

/** The point of a rectangle nearest to (x, y), or (x, y) itself inside it. */
function nearestPoint(x: number, y: number, t: TargetRect): { x: number; y: number } {
  return {
    x: Math.max(t.rect.left, Math.min(t.rect.right, x)),
    y: Math.max(t.rect.top, Math.min(t.rect.bottom, y)),
  };
}

/**
 * Pre-highlights a likely target the pointer is heading towards. Feed it the pointer the person sees
 * (the fixation smoother's output). The raw webcam estimate is far too noisy to read a direction from
 * (about 240 pt RMS in the simulated benchmark); the smoothed pointer holds still during a fixation
 * and jumps once a saccade is confirmed, so a fast move of minTravelPx or more is a real eye movement,
 * and its direction says where the eyes went.
 */
export class HeadingPredictor {
  private o: PredictOptions;
  private track: { t: number; x: number; y: number }[] = [];
  private predicted: { id: string; until: number } | null = null;

  constructor(options: Partial<PredictOptions> = {}) {
    this.o = { ...DEFAULT_PREDICT, ...options };
  }

  setOptions(options: Partial<PredictOptions>): void {
    this.o = { ...this.o, ...options };
  }

  get options(): PredictOptions {
    return this.o;
  }

  reset(): void {
    this.track = [];
    this.predicted = null;
  }

  /** The predicted target at time t, if any. */
  current(t: number): string | null {
    return this.predicted && t <= this.predicted.until ? this.predicted.id : null;
  }

  /** Dwell scale for a target the eyes just landed on: shorter only for a predicted, safe target. */
  dwellScaleFor(target: IntentTarget | undefined, t: number): number {
    if (!target || target.consequential || target.gate) return 1;
    if (this.current(t) !== target.id) return 1;
    return Math.max(0.5, Math.min(1, this.o.dwellScale));
  }

  update(
    s: { t: number; x: number; y: number; confidence: number },
    targets: readonly IntentTarget[],
    intent: Partial<IntentOptions> = {},
  ): string | null {
    const o = this.o;
    if (s.confidence < o.minConfidence) return this.current(s.t);
    this.track.push({ t: s.t, x: s.x, y: s.y });
    while (this.track.length > 2 && s.t - this.track[0]!.t > o.windowMs) this.track.shift();
    const first = this.track[0]!;
    const dt = (s.t - first.t) / 1000;
    const vx = s.x - first.x;
    const vy = s.y - first.y;
    const travel = Math.hypot(vx, vy);
    if (dt > 0 && travel >= o.minTravelPx && travel / dt >= o.minSpeedPxS) {
      const io = { ...DEFAULT_INTENT, ...intent };
      let best: { id: string; angle: number; prior: number } | null = null;
      for (const t of targets) {
        if (t.consequential || t.gate) continue;
        const prior = effectivePrior(t, io);
        if (prior < o.minPrior) continue;
        const p = nearestPoint(s.x, s.y, t);
        const tx = p.x - s.x;
        const ty = p.y - s.y;
        const ahead = Math.hypot(tx, ty);
        if (ahead > o.maxDistancePx) continue;
        // Already there: the direction is whatever brought the pointer here.
        const angle = ahead === 0 ? 0 : angleTo(vx, vy, tx, ty);
        if (angle > o.maxAngleDeg) continue;
        if (!best || prior > best.prior || (prior === best.prior && angle < best.angle)) {
          best = { id: t.id, angle, prior };
        }
      }
      if (best) this.predicted = { id: best.id, until: s.t + o.holdMs };
    }
    return this.current(s.t);
  }
}

// --- Adaptive layout -------------------------------------------------------------------------

export type PrecisionLevel = "sharp" | "normal" | "rough";

export interface PrecisionMeterOptions {
  /** Error radius (px) at or below which tracking is sharp. */
  sharpPx: number;
  /** Error radius (px) at or above which tracking is rough. */
  roughPx: number;
  /** Hysteresis around both thresholds (px). */
  marginPx: number;
  /** Time constant of the error radius average (ms). */
  smoothingMs: number;
  /** A new level must hold this long before it is reported (ms). */
  holdMs: number;
}

export const DEFAULT_PRECISION_METER: PrecisionMeterOptions = {
  sharpPx: 60,
  roughPx: 120,
  marginPx: 10,
  smoothingMs: 2000,
  holdMs: 3000,
};

/** The level for an error radius, with hysteresis relative to the current level. */
export function precisionFor(
  errorRadius: number,
  current: PrecisionLevel,
  o: PrecisionMeterOptions = DEFAULT_PRECISION_METER,
): PrecisionLevel {
  const m = o.marginPx;
  if (current === "rough")
    return errorRadius < o.roughPx - m ? (errorRadius <= o.sharpPx - m ? "sharp" : "normal") : "rough";
  if (current === "sharp")
    return errorRadius > o.sharpPx + m ? (errorRadius >= o.roughPx + m ? "rough" : "normal") : "sharp";
  if (errorRadius >= o.roughPx + m) return "rough";
  if (errorRadius <= o.sharpPx - m) return "sharp";
  return "normal";
}

/** Tracks how precise eye control is right now: an averaged error radius, a level, hysteresis. */
export class PrecisionMeter {
  private o: PrecisionMeterOptions;
  private avg: number | null = null;
  private lastT: number | null = null;
  private lvl: PrecisionLevel = "normal";
  private pending: { level: PrecisionLevel; since: number } | null = null;

  constructor(options: Partial<PrecisionMeterOptions> = {}) {
    this.o = { ...DEFAULT_PRECISION_METER, ...options };
  }

  get level(): PrecisionLevel {
    return this.lvl;
  }

  /** The averaged error radius (px), or null before the first update. */
  get errorRadius(): number | null {
    return this.avg;
  }

  reset(): void {
    this.avg = null;
    this.lastT = null;
    this.lvl = "normal";
    this.pending = null;
  }

  update(t: number, errorRadius: number): PrecisionLevel {
    if (!Number.isFinite(errorRadius)) return this.lvl;
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const a = this.avg === null ? 1 : 1 - Math.exp(-dt / Math.max(1, this.o.smoothingMs));
    this.avg = this.avg === null ? errorRadius : this.avg + a * (errorRadius - this.avg);
    const wanted = precisionFor(this.avg, this.lvl, this.o);
    if (wanted === this.lvl) {
      this.pending = null;
    } else if (this.pending?.level !== wanted) {
      this.pending = { level: wanted, since: t };
    }
    if (this.pending && t - this.pending.since >= this.o.holdMs) {
      this.lvl = this.pending.level;
      this.pending = null;
    }
    return this.lvl;
  }
}

// --- Selection -------------------------------------------------------------------------------

export interface IntentSelectorTarget extends IntentTarget {
  /** Some targets ask for a longer dwell (e.g. 2 for "Resume eye control"). */
  dwellScale?: number;
}

export interface IntentSelectorOptions {
  dwell: Partial<DwellConfig>;
  intent: Partial<IntentOptions>;
  predict: Partial<PredictOptions>;
  /** Pre-highlight and shorter dwell for a predicted arrival. */
  prediction: boolean;
}

export interface IntentUpdate {
  /** The target the pointer is on (after the prior), or null. */
  targetId: string | null;
  /** The pre-highlighted target, or null. */
  predicted: string | null;
  /** Whether the current dwell is a predicted arrival (shorter). */
  fast: boolean;
  events: DwellEvent[];
}

/**
 * The web app's hands-free selection: chooseTarget (gaze x context) picks the target, the dwell engine
 * decides when it is selected, and the heading predictor may shorten the dwell of a safe, likely target
 * the eyes just moved to. The benchmark (bench/intent.bench.ts) runs this same class.
 */
export class IntentSelector {
  readonly dwell: DwellEngine;
  readonly predictor: HeadingPredictor;
  private intent: Partial<IntentOptions>;
  private prediction: boolean;
  private fastTarget: string | null = null;

  constructor(options: Partial<IntentSelectorOptions> = {}) {
    this.dwell = new DwellEngine(options.dwell);
    this.predictor = new HeadingPredictor(options.predict);
    this.intent = options.intent ?? {};
    this.prediction = options.prediction ?? true;
  }

  setOptions(options: Partial<IntentSelectorOptions>): void {
    if (options.dwell) this.dwell.setConfig(options.dwell);
    if (options.predict) this.predictor.setOptions(options.predict);
    if (options.intent) this.intent = { ...this.intent, ...options.intent };
    if (options.prediction !== undefined) this.prediction = options.prediction;
  }

  /** Forget the dwell and the prediction, and block selection for holdMs (e.g. after navigation). */
  reset(now: number, holdMs?: number): void {
    this.dwell.reset(now, holdMs);
    this.predictor.reset();
    this.fastTarget = null;
  }

  update(
    s: { t: number; x: number; y: number; confidence: number; errorRadius: number },
    targets: readonly IntentSelectorTarget[],
  ): IntentUpdate {
    const targetId = chooseTarget(s.x, s.y, s.errorRadius, targets, this.intent);
    const target = targetId === null ? undefined : targets.find((t) => t.id === targetId);
    const predicted = this.prediction ? this.predictor.update(s, targets, this.intent) : null;
    const arriving =
      this.prediction && target && this.predictor.dwellScaleFor(target, s.t) < 1 ? target.id : null;
    const dwelling = this.dwell.snapshot().targetId;
    // A predicted arrival keeps its shorter dwell for as long as that dwell lasts.
    const fastNow =
      targetId !== null && (targetId === this.fastTarget || (dwelling !== targetId && arriving === targetId));
    const events = this.dwell.update({
      t: s.t,
      x: s.x,
      y: s.y,
      confidence: s.confidence,
      targetId,
      dwellScale: (target?.dwellScale ?? 1) * (fastNow ? this.fastScale(target) : 1),
    });
    for (const e of events) {
      if (e.type === "enter") this.fastTarget = arriving === e.targetId ? e.targetId : null;
      else if (e.type === "cancel" || e.type === "activate") this.fastTarget = null;
    }
    return { targetId, predicted, fast: this.fastTarget !== null && this.fastTarget === targetId, events };
  }

  private fastScale(target: IntentSelectorTarget | undefined): number {
    if (!target || target.consequential || target.gate) return 1;
    return Math.max(0.5, Math.min(1, this.predictor.options.dwellScale));
  }
}
