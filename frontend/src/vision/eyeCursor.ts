/**
 * The eye cursor: the irises' position in the camera picture moves the cursor directly, mirrored, like the classic
 * MediaPipe eye mouse (iris landmark -> screen). Instant and predictable, no calibration.
 *
 * - Both irises averaged (468 and 473): half the landmark noise of one.
 * - Centred on the person: the first third of a second after a face appears is the middle of the screen, and a
 *   face gone for 2 seconds (someone new sits down) is centred afresh. A cursor stuck in a top corner came from
 *   taking a single first frame as the middle.
 * - One-frame spikes are ignored: a jump across the screen only counts when the next frame agrees.
 * - One Euro filtered: steady when the eyes rest, quick when they move.
 * - Holds still only while the eyes are really closed. Looking down at the dock lowers the eyelids, which the face
 *   model scores as a partial blink: that must not freeze the cursor.
 */

import { OneEuroFilter } from "../../../os/gaze/src/oneEuro";

/** Iris centres in the face mesh (with refined landmarks). */
const IRISES = [468, 473] as const;
/** Screen fraction per fraction of the camera picture the irises move (more vertically: eyes move less up-down). */
export const EYE_GAIN = { x: 2.2, y: 3.0 };
/** Frames averaged as the middle when a face appears (a third of a second at 30 fps). */
const SETTLE_FRAMES = 10;
/** A face gone this long is someone new. */
const NEW_PERSON_MS = 2000;
/** Blink score that means the eyes are really closed. */
const CLOSED = 0.75;
/** A jump larger than this (screen fraction) in one frame needs the next frame to agree. */
const SPIKE = 0.2;

type Pt = { x: number; y: number };

export class EyeCursor {
  private centre: Pt | null = null;
  private settling: Pt[] = [];
  private lastSeen = -Infinity;
  private last: Pt | null = null;
  private raw: Pt | null = null;
  private pending: Pt | null = null;
  private fx = new OneEuroFilter({ minCutoff: 1.0, beta: 4.0, dCutoff: 1.0 });
  private fy = new OneEuroFilter({ minCutoff: 1.0, beta: 4.0, dCutoff: 1.0 });

  /** Start again: the next moment of looking becomes the middle of the screen. */
  recentre(): void {
    this.centre = null;
    this.settling = [];
    this.last = null;
    this.raw = null;
    this.pending = null;
    this.fx.reset();
    this.fy.reset();
  }

  /** Where the irises are in the picture, mirrored (so looking right moves right). */
  static measure(landmarks: readonly { x: number; y: number }[]): Pt | null {
    const pts = IRISES.map((i) => landmarks[i]).filter((p): p is { x: number; y: number } => !!p);
    if (!pts.length) return null;
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { x: 1 - x, y };
  }

  /** The cursor as a fraction of the screen (0..1 each way), or null with no face. */
  update(landmarks: readonly { x: number; y: number }[] | null, t: number, blink: number | null): Pt | null {
    const m = landmarks ? EyeCursor.measure(landmarks) : null;
    if (!m) return null;
    if (t - this.lastSeen > NEW_PERSON_MS) this.recentre();
    this.lastSeen = t;
    if (!this.centre) {
      this.settling.push(m);
      if (this.settling.length < SETTLE_FRAMES) return { x: 0.5, y: 0.5 };
      const k = this.settling.length;
      this.centre = {
        x: this.settling.reduce((s, p) => s + p.x, 0) / k,
        y: this.settling.reduce((s, p) => s + p.y, 0) / k,
      };
      this.settling = [];
    }
    if ((blink ?? 0) >= CLOSED && this.last) return this.last;
    const target = {
      x: clamp(0.5 + (m.x - this.centre.x) * EYE_GAIN.x),
      y: clamp(0.5 + (m.y - this.centre.y) * EYE_GAIN.y),
    };
    if (this.raw && dist(target, this.raw) > SPIKE) {
      // A big jump: take it only when the next frame lands near it too (a real move, not a glitch).
      const confirmed = this.pending && dist(target, this.pending) < SPIKE / 2;
      this.pending = confirmed ? null : target;
      if (!confirmed) return this.last;
    } else this.pending = null;
    this.raw = target;
    this.last = { x: clamp(this.fx.filter(target.x, t)), y: clamp(this.fy.filter(target.y, t)) };
    return this.last;
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
