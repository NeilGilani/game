/**
 * Target magnetism: which target the person is looking at, from a gaze estimate that is noisy and
 * a little off. Instead of a pointer that wobbles over the screen, the person sees a calm highlight
 * on the target they are looking at (with its dwell ring filling).
 *
 * - A lock goes to the nearest target within reach of the estimate. Reach adapts to how accurate
 *   tracking is right now (the engine's error radius, about two standard deviations): never less
 *   than the person's snap distance, never more than maxReachPx.
 * - Hysteresis: another target takes over only once it has been clearly closer (by the hysteresis
 *   margin) for switchMs in a row. When two targets are about equally close, which is exactly when
 *   the tracker can't tell them apart, the current one stays until the evidence clearly favours
 *   the other.
 * - The lock is released when the estimate has been out of reach for releaseMs, or the target is
 *   gone. Frames with low confidence (a blink, the frame of a saccade, a glance away) never lock or
 *   switch; a lock is held through them for up to holdLostMs.
 *
 * Pure and deterministic. Compared with a plain 48 px snap in bench/app.bench.ts; the snap did as
 * well or better there, so the web app uses the snap and this stays an option for the overlay.
 */

import { type TargetRect, distanceToRect } from "./targets";

export interface MagnetOptions {
  /** Least reach, px beyond a target's edge (the person's "snap distance" preference). */
  snapPx: number;
  /** Most reach, however inaccurate tracking is, so far-away targets are never grabbed. */
  maxReachPx: number;
  /** Hysteresis margin as a fraction of the reach, kept within minPx..maxPx. */
  hysteresisFraction: number;
  minHysteresisPx: number;
  maxHysteresisPx: number;
  /** A first lock waits until the same target has been the nearest for this long (ms). */
  lockMs: number;
  /** Another target must be clearly closer for this long before it takes over (ms). */
  switchMs: number;
  /** Release the lock after the estimate has been out of reach for this long (ms). */
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
  lockMs: 100,
  switchMs: 200,
  releaseMs: 400,
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
  /** Reach and hysteresis used for this update (px). */
  reach: number;
  hysteresis: number;
  /**
   * Whether this frame's estimate supports the lock: it is inside the locked target or no other
   * target is closer. False while the highlight holds through a wobble towards a neighbour, and on
   * low-confidence frames.
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

export class TargetMagnet {
  private o: MagnetOptions;
  private lock: string | null = null;
  /** The target gathering evidence for a first lock or a switch, and since when. */
  private candidate: { id: string; since: number } | null = null;
  private outsideSince: number | null = null;
  private lowSince: number | null = null;

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
  }

  private release(): void {
    this.lock = null;
    this.candidate = null;
    this.outsideSince = null;
  }

  update(s: MagnetSample, targets: readonly TargetRect[]): MagnetResult {
    const reach = this.reach(s.errorRadius ?? 0);
    const hysteresis = this.hysteresis(reach);
    const before = this.lock;
    let supported = false;
    const result = (): MagnetResult => ({
      targetId: this.lock,
      changed: this.lock !== before,
      reach,
      hysteresis,
      supported: supported && this.lock !== null,
    });

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

    const near = nearestTarget(s.x, s.y, targets);
    if (this.lock === null || !current) {
      if (!near || near.distance > reach) {
        this.candidate = null;
        return result();
      }
      if (this.candidate?.id !== near.id) this.candidate = { id: near.id, since: s.t };
      if (s.t - this.candidate.since >= this.o.lockMs) {
        this.lock = near.id;
        this.candidate = null;
        this.outsideSince = null;
        supported = true;
      }
      return result();
    }

    const distance = distanceToRect(s.x, s.y, current.rect);
    supported = distance === 0 || !near || near.id === current.id || distance <= near.distance;
    const challenger =
      near && near.id !== current.id && near.distance <= reach && near.distance + hysteresis < distance;
    if (challenger) {
      if (this.candidate?.id !== near.id) this.candidate = { id: near.id, since: s.t };
      if (s.t - this.candidate.since >= this.o.switchMs) {
        this.lock = near.id;
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
    if (distance > reach) supported = false;
    return result();
  }
}
