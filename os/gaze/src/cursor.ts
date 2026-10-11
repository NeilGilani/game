/**
 * The drawn gaze cursor: glides after the eyes instead of shaking.
 *
 * The engine's fixation smoother (fixation.ts) decides when the eyes jumped and how noisy this
 * person's samples are. This turns that into a cursor that can be drawn on every display frame:
 *
 * - While the eyes fixate, a Kalman filter on the calibrated samples estimates where they rest.
 *   Its process noise shrinks as the fixation goes on, so the longer someone looks, the harder it
 *   smooths (towards the mean of the whole fixation). Wild frames are down-weighted (Huber), and
 *   drift and microsaccades under the smoother's minimum saccade (1 degree) never move it far.
 * - When the smoother reports a saccade (a jump confirmed by two or more frames), the cursor
 *   glides from where it is drawn to the new estimate in 120 to 180 ms (longer for longer jumps)
 *   with an ease-out curve: no snap, and no slow slide.
 * - Between camera frames (about 30 a second) the cursor follows the estimate through a critically
 *   damped spring evaluated at the draw time, so it moves on every display frame, never in 30 fps
 *   steps. The spring also softens as the fixation lasts.
 * - Frames with the eyes closing or closed, or with low tracking confidence, never move it: the
 *   cursor holds exactly where it is drawn, and keeps holding briefly after the eyes reopen.
 *
 * Time is the caller's clock (frame timestamps and draw times on the same clock), so tests and
 * replays are deterministic.
 */

import type { SmoothedPoint } from "./fixation";

export interface CursorOptions {
  /** Glide duration after a saccade (ms): shortest for small jumps, longest for jumps of glideFarPt. */
  minGlideMs: number;
  maxGlideMs: number;
  glideFarPt: number;
  /** Kalman process noise (points per sqrt(second)) at the start of a fixation and after a long one. */
  driftStartPt: number;
  driftEndPt: number;
  /** How quickly the smoothing strengthens as a fixation goes on (ms). */
  strengthenMs: number;
  /**
   * Samples further than this many standard deviations from the estimate are down-weighted, once
   * the fixation has lasted huberAfterMs (before that the landing point is still being found).
   */
  huber: number;
  huberAfterMs: number;
  /**
   * A saccade the smoother hasn't confirmed yet: the trimmed mean of the last 4 to jumpMaxK samples is
   * further from the estimate than jumpSigma standard deviations (and than the minimum saccade).
   * With webcam noise the smoother's fixed thresholds can miss even a 10 degree jump; this test
   * uses the estimate's own, much smaller, uncertainty.
   */
  jumpSigma: number;
  jumpMaxK: number;
  /** Spring time constant between camera frames (ms): right after a saccade, and after a long look. */
  springStartMs: number;
  springEndMs: number;
  /** Hold the cursor on frames with a blink score at or above this, or tracking below minTracking. */
  blinkHold: number;
  minTracking: number;
  /** Keep holding this long after the eyes reopen or tracking recovers (landmarks settle). */
  reopenMs: number;
}

export const DEFAULT_CURSOR: CursorOptions = {
  minGlideMs: 120,
  maxGlideMs: 180,
  glideFarPt: 600,
  driftStartPt: 100,
  driftEndPt: 12,
  strengthenMs: 400,
  huber: 2.5,
  huberAfterMs: 200,
  jumpSigma: 3.5,
  jumpMaxK: 20,
  springStartMs: 30,
  springEndMs: 50,
  blinkHold: 0.25,
  minTracking: 0.5,
  reopenMs: 120,
};

export interface CursorFrame {
  t: number;
  /** Calibrated estimate before smoothing (points), or null when there is none. */
  raw: { x: number; y: number } | null;
  /** The fixation smoother's output for this frame (saccades, fixation time, learned noise). */
  smoothed: SmoothedPoint | null;
  /** Face-level tracking confidence (not the sample confidence, which dips on saccade frames). */
  tracking: number;
  blink: number | null;
  /** Smallest move that counts as a saccade (points): about 1 degree (FixationSmoother.minSaccadePt). */
  minJumpPt: number;
}

type Pt = { x: number; y: number };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (pts: readonly Pt[]): Pt => ({
  x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
  y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
});

/**
 * Ease-out (cubic): leaves quickly, as the eye does, and lands softly with zero velocity. Measured
 * against a symmetric minimum-jerk ease in bench/cursor.bench.ts: it settles sooner for the same
 * glide duration.
 */
function easeOut(u: number): number {
  const s = Math.max(0, Math.min(1, u));
  return 1 - (1 - s) ** 3;
}

/** A critically damped spring towards a fixed target, evaluated in closed form at any time. */
class Spring {
  pos: Pt = { x: 0, y: 0 };
  vel: Pt = { x: 0, y: 0 };
  target: Pt = { x: 0, y: 0 };
  t = 0;
  tauMs = 50;

  set(t: number, p: Pt): void {
    this.pos = { ...p };
    this.vel = { x: 0, y: 0 };
    this.target = { ...p };
    this.t = t;
  }

  /** State at time t (no mutation). Times before the last update return the last state. */
  at(t: number): { pos: Pt; vel: Pt } {
    const dt = Math.max(0, t - this.t);
    const w = 1 / this.tauMs;
    const e = Math.exp(-w * dt);
    const axis = (p: number, v: number, g: number) => {
      const x0 = p - g;
      const c = v + w * x0;
      return { p: g + (x0 + c * dt) * e, v: (v - w * c * dt) * e };
    };
    const ax = axis(this.pos.x, this.vel.x, this.target.x);
    const ay = axis(this.pos.y, this.vel.y, this.target.y);
    return { pos: { x: ax.p, y: ay.p }, vel: { x: ax.v, y: ay.v } };
  }

  /** Advance to t, then aim at a new target with a new time constant. */
  retarget(t: number, target: Pt, tauMs: number): void {
    const s = this.at(t);
    this.pos = s.pos;
    this.vel = s.vel;
    this.t = Math.max(t, this.t);
    this.target = { ...target };
    this.tauMs = tauMs;
  }
}

/** Constant-position Kalman filter, both axes sharing one variance (the noise is isotropic). */
class FixationKalman {
  x: Pt = { x: 0, y: 0 };
  /** Variance of the estimate per axis (points squared). */
  p = 0;
  t = 0;

  start(t: number, at: Pt, variance: number): void {
    this.x = { ...at };
    this.p = variance;
    this.t = t;
  }

  update(t: number, z: Pt, r: number, q: number, huber: number): void {
    const dt = Math.max(0, t - this.t) / 1000;
    this.t = t;
    this.p += q * dt;
    const s = this.p + r;
    // Mahalanobis distance of the sample (2D, isotropic); beyond `huber` sigmas, trust it less.
    const d = Math.hypot(z.x - this.x.x, z.y - this.x.y) / Math.sqrt(s);
    const rEff = d > huber ? r * (d / huber) ** 2 : r;
    const k = this.p / (this.p + rEff);
    this.x = { x: this.x.x + k * (z.x - this.x.x), y: this.x.y + k * (z.y - this.x.y) };
    this.p = (1 - k) * this.p;
  }
}

export class GazeCursor {
  private o: CursorOptions;
  private kalman = new FixationKalman();
  private spring = new Spring();
  private glide: { from: Pt; t0: number; ms: number } | null = null;
  private started = false;
  private fixationStart = 0;
  /** Trusted samples of the current fixation, newest last (at most jumpMaxK). */
  private recent: Pt[] = [];
  /** Drawn position while holding (blink, low confidence); null when following. */
  private held: Pt | null = null;
  private holdUntil = -Infinity;
  /** The smoother reported a saccade while the cursor was holding. */
  private missedSaccade = false;

  constructor(options: Partial<CursorOptions> = {}) {
    this.o = { ...DEFAULT_CURSOR, ...options };
  }

  setOptions(options: Partial<CursorOptions>): void {
    this.o = { ...this.o, ...options };
  }

  reset(): void {
    this.started = false;
    this.glide = null;
    this.held = null;
    this.holdUntil = -Infinity;
    this.missedSaccade = false;
    this.recent = [];
  }

  /** True while the cursor is held still (blink, low confidence, or just after). */
  get holding(): boolean {
    return this.held !== null;
  }

  /** True when this blink score is enough to hold the cursor. */
  blinking(blink: number | null): boolean {
    return (blink ?? 0) >= this.o.blinkHold;
  }

  /** Where to draw the cursor at time t (same clock as the frames), or null before the first sample. */
  at(t: number): Pt | null {
    if (!this.started) return null;
    if (this.held) return { ...this.held };
    const g = this.spring.at(t).pos;
    const glide = this.glide;
    if (!glide || t >= glide.t0 + glide.ms) return g;
    const e = easeOut((t - glide.t0) / glide.ms);
    return { x: glide.from.x + (g.x - glide.from.x) * e, y: glide.from.y + (g.y - glide.from.y) * e };
  }

  /** Hold the cursor where it is drawn now (a blink, a lost face, low confidence). */
  hold(t: number): void {
    if (!this.started) return;
    this.held ??= this.at(t);
    this.holdUntil = t + this.o.reopenMs;
  }

  /** A camera frame of eye gaze. */
  gaze(f: CursorFrame): void {
    const s = f.smoothed;
    const trusted =
      f.raw !== null && s !== null && f.tracking >= this.o.minTracking && !this.blinking(f.blink);
    if (!trusted) {
      if (s?.saccade) this.missedSaccade = true;
      this.hold(f.t);
      return;
    }
    if (f.t < this.holdUntil) {
      // Eyes just reopened (or tracking just came back): keep still while the landmarks settle.
      if (s.saccade) this.missedSaccade = true;
      return;
    }
    const raw = f.raw!;
    const r = (s.noisePt * s.noisePt) / 2; // per-axis variance of one sample
    const centre = { x: s.x, y: s.y };
    const centreVar = Math.max((s.outputNoisePt * s.outputNoisePt) / 2, 1);

    if (!this.started) {
      this.started = true;
      this.kalman.start(f.t, centre, centreVar);
      this.spring.set(f.t, centre);
      this.fixationStart = f.t;
      this.recent = [raw];
      return;
    }

    let jump = s.saccade;
    if (this.held) {
      // Resume exactly where the cursor was held, without a jump.
      this.spring.set(f.t, this.held);
      this.held = null;
      if (this.missedSaccade) {
        // The eyes may have moved during the blink: glide if the smoother now sees them elsewhere.
        const far = Math.hypot(centre.x - this.kalman.x.x, centre.y - this.kalman.x.y);
        jump = far > 3 * Math.sqrt(2 * (this.kalman.p + centreVar));
      }
    }
    this.missedSaccade = false;

    this.recent.push(raw);
    if (this.recent.length > this.o.jumpMaxK) this.recent.shift();
    let target = centre;
    let targetVar = Math.max(centreVar, r);
    if (!jump) {
      const moved = this.movedTo(r, f.minJumpPt);
      if (moved) {
        jump = true;
        target = moved.at;
        targetVar = moved.variance;
      }
    }

    if (jump) {
      const from = this.at(f.t)!;
      // The centre right after a jump rests on a few frames, some maybe in transit: hold it loosely.
      this.kalman.start(f.t, target, targetVar);
      this.fixationStart = f.t;
      if (s.saccade) this.recent = [raw];
      const dist = Math.hypot(target.x - from.x, target.y - from.y);
      const ms =
        this.o.minGlideMs + (this.o.maxGlideMs - this.o.minGlideMs) * Math.min(1, dist / this.o.glideFarPt);
      this.glide = { from, t0: f.t, ms };
      this.spring.set(f.t, target);
      this.spring.tauMs = this.o.springStartMs;
      return;
    }

    const fixMs = f.t - this.fixationStart;
    const grow = 1 - Math.exp(-fixMs / this.o.strengthenMs);
    const drift = this.o.driftStartPt + (this.o.driftEndPt - this.o.driftStartPt) * grow;
    this.kalman.update(f.t, raw, r, drift * drift, fixMs >= this.o.huberAfterMs ? this.o.huber : Infinity);
    const tau = this.o.springStartMs + (this.o.springEndMs - this.o.springStartMs) * grow;
    this.spring.retarget(f.t, this.kalman.x, tau);
  }

  /**
   * Have the last few samples settled somewhere else? Tests runs of 4 to jumpMaxK of them (newest
   * last); the wildest tenth of each run (at least one sample) is left out, so a single wild frame
   * can't make or break it. Longer runs catch smaller jumps: about 4 degrees within half a second at webcam noise. Returns where they are and how sure that is (per-axis variance).
   */
  private movedTo(r: number, minPt: number): { at: Pt; variance: number } | null {
    const n = this.recent.length;
    for (let k = 4; k <= n; k++) {
      // Leave out the wildest tenth (at least one) of the run.
      const all = this.recent.slice(n - k);
      const centre = mean(all);
      const drop = Math.max(1, Math.floor(k / 10));
      const run = all.sort((a, b) => dist(a, centre) - dist(b, centre)).slice(0, k - drop);
      const m = mean(run);
      const sd = Math.sqrt(r / run.length + this.kalman.p);
      if (dist(m, this.kalman.x) > Math.max(minPt, this.o.jumpSigma * sd)) {
        this.recent = this.recent.slice(n - k);
        return { at: m, variance: r / run.length };
      }
    }
    return null;
  }

  /** A camera frame from a pointer that needs no fixation filtering (head pointer, external): glide between frames. */
  follow(t: number, p: Pt, tauMs = this.o.springStartMs): void {
    if (!this.started) {
      this.started = true;
      this.spring.set(t, p);
      return;
    }
    if (this.held) {
      if (t < this.holdUntil) return;
      this.spring.set(t, this.held);
      this.held = null;
    }
    this.glide = null;
    this.spring.retarget(t, p, tauMs);
  }
}
