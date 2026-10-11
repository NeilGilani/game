/**
 * Target magnetism: which target the person is looking at, from a gaze estimate that is noisy and
 * a little off. Instead of a pointer that wobbles over the screen, the person sees the cursor sit
 * still in the middle of the target they are looking at, the target highlighted, its dwell ring
 * filling.
 *
 * - Choice by probability. The estimate is modelled as the true gaze point (anywhere on the
 *   target) plus round Gaussian error with sigma = reach / 2 (the engine's error radius is about
 *   two sigma). Each target's likelihood is the share of that error blob over the target, per unit
 *   of area (targetLikelihood). The most likely target wins, not just the one under the estimate.
 *   Likelihoods are smoothed over evidenceMs so one stray frame doesn't count as a look.
 * - Reach adapts to how accurate tracking is right now: never less than the person's snap
 *   distance, never more than maxReachPx. Only targets within reach of the estimate can be locked.
 * - Hysteresis. Once locked, the cursor stays on the target's centre. Another target takes over
 *   only when it is `stickiness` times as likely for switchMs in a row: when two targets are about
 *   equally likely, which is exactly when the tracker can't tell them apart, the locked one stays.
 *   The lock is released only once the estimate has been clearly outside the target (beyond reach
 *   plus a margin, both scaled to the error radius) for releaseMs, or the target is gone.
 * - A frame supports the lock (and the dwell ring fills) only while the estimate is within reach and
 *   no other target has more evidence; otherwise the ring pauses where it is.
 * - Frames with low confidence (a blink, the frame of a saccade) never lock or switch; a lock is
 *   held through them for up to holdLostMs.
 *
 * Pure and deterministic. Compared with a plain 48 px snap in bench/app.bench.ts (simulated): about
 * as accurate on 96 px targets and a little slower to select, more accurate on larger targets, a
 * steadier highlight, and no more false selections while reading.
 */

import { type Rect, type TargetRect, distanceToRect } from "./targets";

export interface MagnetOptions {
  /** Least reach, px beyond a target's edge (the person's "snap distance" preference). */
  snapPx: number;
  /** Most reach, however inaccurate tracking is, so far-away targets are never grabbed. */
  maxReachPx: number;
  /** Release margin beyond reach, as a fraction of the reach, kept within minPx..maxPx. */
  hysteresisFraction: number;
  minHysteresisPx: number;
  maxHysteresisPx: number;
  /** A challenger must be this many times as likely as the locked target to take over. */
  stickiness: number;
  /** Time constant (ms) over which each target's likelihood is smoothed. */
  evidenceMs: number;
  /** A first lock waits until the same target has been the most likely for this long (ms). */
  lockMs: number;
  /** Another target must be clearly more likely for this long before it takes over (ms). */
  switchMs: number;
  /** Release the lock after the estimate has been clearly outside the target for this long (ms). */
  releaseMs: number;
  /** Hold the lock through low-confidence frames for at most this long (ms). */
  holdLostMs: number;
  minConfidence: number;
}

export const DEFAULT_MAGNET: MagnetOptions = {
  snapPx: 48,
  maxReachPx: 160,
  hysteresisFraction: 0.25,
  minHysteresisPx: 12,
  maxHysteresisPx: 40,
  stickiness: 4,
  evidenceMs: 100,
  lockMs: 100,
  switchMs: 200,
  releaseMs: 180,
  holdLostMs: 1500,
  minConfidence: 0.5,
};

export interface MagnetSample {
  t: number;
  x: number;
  y: number;
  confidence: number;
  /** About two standard deviations of the estimate's error (px); 0 when precise or unknown. */
  errorRadius?: number;
}

export interface MagnetResult {
  targetId: string | null;
  /** True on the update where the lock moved (to another target, or to none). */
  changed: boolean;
  /** Where to draw the cursor: the locked target's centre, else the estimate itself. */
  cursor: { x: number; y: number };
  /** Reach and release margin used for this update (px). */
  reach: number;
  hysteresis: number;
  /**
   * Whether this frame's estimate supports the lock: it is within reach of the locked target and
   * no other target is more likely. False while the lock holds through a glance away or a wobble
   * towards a neighbour, and on low-confidence frames.
   */
  supported: boolean;
}

/** The nearest target (0 inside it); ties go to the smallest, like findTarget. */
export function nearestTarget(
  x: number,
  y: number,
  targets: readonly TargetRect[],
): { id: string; distance: number } | null {
  let best: { id: string; distance: number; area: number } | null = null;
  for (const t of targets) {
    const distance = distanceToRect(x, y, t.rect);
    const area = (t.rect.right - t.rect.left) * (t.rect.bottom - t.rect.top);
    if (!best || distance < best.distance || (distance === best.distance && area < best.area)) {
      best = { id: t.id, distance, area };
    }
  }
  return best ? { id: best.id, distance: best.distance } : null;
}

/** Complementary error function (Numerical Recipes' erfcc): relative error below 1.2e-7, tails included. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Share of a normal distribution (mean mu, sd sigma) that falls in lo..hi, accurate in the tails. */
function intervalMass(lo: number, hi: number, mu: number, sigma: number): number {
  const a = (lo - mu) / (sigma * Math.SQRT2);
  const b = (hi - mu) / (sigma * Math.SQRT2);
  if (a >= 0) return 0.5 * (erfc(a) - erfc(b));
  if (b <= 0) return 0.5 * (erfc(-b) - erfc(-a));
  return 1 - 0.5 * (erfc(b) + erfc(-a));
}

/**
 * How likely an estimate at (x, y) is if the person is looking at `rect`, with the gaze point
 * anywhere on the target and round Gaussian error of sd `sigma`: the error blob's share over the
 * target, divided by its area. Only ratios between targets mean anything.
 */
export function targetLikelihood(x: number, y: number, sigma: number, rect: Rect): number {
  const s = Math.max(1, sigma);
  const area = Math.max(1, (rect.right - rect.left) * (rect.bottom - rect.top));
  return (intervalMass(rect.left, rect.right, x, s) * intervalMass(rect.top, rect.bottom, y, s)) / area;
}

export function rectCentre(rect: Rect): { x: number; y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

export class TargetMagnet {
  private o: MagnetOptions;
  private lock: string | null = null;
  /** The target gathering evidence for a first lock or a switch, and since when. */
  private candidate: { id: string; since: number } | null = null;
  private outsideSince: number | null = null;
  private lowSince: number | null = null;
  /** Smoothed likelihood per target id. */
  private evidence = new Map<string, number>();
  private lastGoodT: number | null = null;

  constructor(options: Partial<MagnetOptions> = {}) {
    this.o = { ...DEFAULT_MAGNET, ...options };
  }

  setOptions(options: Partial<MagnetOptions>): void {
    this.o = { ...this.o, ...options };
  }

  get options(): MagnetOptions {
    return this.o;
  }

  get current(): string | null {
    return this.lock;
  }

  /** Reach for an error radius (px). */
  reach(errorRadius = 0): number {
    const lo = Math.max(0, this.o.snapPx);
    return Math.max(lo, Math.min(Math.max(lo, this.o.maxReachPx), errorRadius));
  }

  /** Release margin beyond reach (px). */
  hysteresis(reach: number): number {
    return Math.max(
      this.o.minHysteresisPx,
      Math.min(this.o.maxHysteresisPx, this.o.hysteresisFraction * reach),
    );
  }

  /** Forget the lock (navigation, a new screen, eye control switched off). */
  reset(): void {
    this.lock = null;
    this.candidate = null;
    this.outsideSince = null;
    this.lowSince = null;
    this.evidence.clear();
    this.lastGoodT = null;
  }

  private release(): void {
    this.lock = null;
    this.candidate = null;
    this.outsideSince = null;
  }

  /** Fold this frame's likelihoods into the smoothed evidence. */
  private gather(s: MagnetSample, sigma: number, targets: readonly TargetRect[]): void {
    const dt = this.lastGoodT === null ? Infinity : Math.max(0, Math.min(100, s.t - this.lastGoodT));
    this.lastGoodT = s.t;
    const alpha = 1 - Math.exp(-dt / Math.max(1, this.o.evidenceMs));
    const next = new Map<string, number>();
    for (const t of targets) {
      // A context prior (input/intent.ts priorsOf) settles what the tracker can't tell apart; reach is unchanged.
      const l = targetLikelihood(s.x, s.y, sigma, t.rect) * (t.prior ?? 1);
      const e = this.evidence.get(t.id) ?? 0;
      next.set(t.id, e + alpha * (l - e));
    }
    this.evidence = next;
  }

  /** The target with the most evidence among those within reach of the estimate. */
  private mostLikely(
    s: MagnetSample,
    reach: number,
    targets: readonly TargetRect[],
  ): { id: string; evidence: number } | null {
    let best: { id: string; evidence: number } | null = null;
    for (const t of targets) {
      if (distanceToRect(s.x, s.y, t.rect) > reach) continue;
      const e = this.evidence.get(t.id) ?? 0;
      if (!best || e > best.evidence) best = { id: t.id, evidence: e };
    }
    return best;
  }

  update(s: MagnetSample, targets: readonly TargetRect[]): MagnetResult {
    const reach = this.reach(s.errorRadius ?? 0);
    const hysteresis = this.hysteresis(reach);
    const before = this.lock;
    let supported = false;
    const result = (): MagnetResult => {
      const locked = this.lock === null ? undefined : targets.find((t) => t.id === this.lock);
      return {
        targetId: this.lock,
        changed: this.lock !== before,
        cursor: locked ? rectCentre(locked.rect) : { x: s.x, y: s.y },
        reach,
        hysteresis,
        supported: supported && this.lock !== null,
      };
    };

    const current = this.lock === null ? undefined : targets.find((t) => t.id === this.lock);
    if (this.lock !== null && !current) this.release();

    if (s.confidence < this.o.minConfidence) {
      // Not evidence for anything: hold what we have, for a while.
      this.candidate = null;
      this.lowSince ??= s.t;
      if (this.lock !== null && s.t - this.lowSince > this.o.holdLostMs) this.release();
      return result();
    }
    this.lowSince = null;

    this.gather(s, reach / 2, targets);
    const best = this.mostLikely(s, reach, targets);

    if (this.lock === null || !current) {
      if (!best || best.evidence <= 0) {
        this.candidate = null;
        return result();
      }
      if (this.candidate?.id !== best.id) this.candidate = { id: best.id, since: s.t };
      if (s.t - this.candidate.since >= this.o.lockMs) {
        this.lock = best.id;
        this.candidate = null;
        this.outsideSince = null;
        supported = true;
      }
      return result();
    }

    const distance = distanceToRect(s.x, s.y, current.rect);
    const held = this.evidence.get(current.id) ?? 0;
    const challenger = best !== null && best.id !== current.id && best.evidence > this.o.stickiness * held;
    if (challenger) {
      if (this.candidate?.id !== best.id) this.candidate = { id: best.id, since: s.t };
      if (s.t - this.candidate.since >= this.o.switchMs) {
        this.lock = best.id;
        this.candidate = null;
        this.outsideSince = null;
        supported = true;
        return result();
      }
    } else {
      this.candidate = null;
    }

    if (distance > reach + hysteresis) {
      this.outsideSince ??= s.t;
      if (s.t - this.outsideSince >= this.o.releaseMs) this.release();
    } else {
      this.outsideSince = null;
    }

    // Supported: within reach, and no other target has gathered more evidence than the locked one.
    const mine = this.evidence.get(current.id) ?? 0;
    supported = distance <= reach;
    for (const [id, e] of this.evidence) if (id !== current.id && e > mine) supported = false;
    return result();
  }
}
