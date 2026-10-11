/**
 * The eye cursor's pointer: the nose tip in the camera picture moves the cursor, mirrored, like the classic webcam
 * head mouse. It replaces the iris landmark, which drops out exactly when it's needed most: looking down at the
 * dock lowers the eyelids, the face model reads that as a blink, and the cursor froze or was lost. The nose tip is
 * always visible, moves the most when the head turns, and doesn't care about eyelids.
 *
 * - Scaled by the face's width in the picture, so sitting nearer or further from the camera feels the same.
 * - Centred on the person: the first half second after a face appears is averaged as the middle of the screen,
 *   and a face that has been gone for 2 seconds (someone new sits down) is centred afresh.
 * - One Euro filtered: steady when the head is still, quick when it moves.
 * - Holds still only through a real eye closure (a deliberate long blink), not a downward look.
 */

import { OneEuroFilter } from "../../../os/gaze/src/oneEuro";

/** Face mesh landmarks: nose tip and the two sides of the face. */
const NOSE = 1;
const LEFT = 234;
const RIGHT = 454;

/** Screen fraction per face width of nose movement: about 15 degrees of turn reaches the sides, 12 of nod the dock. */
export const NOSE_GAIN = { x: 4.5, y: 6 };
/** Frames averaged as the centre when a face appears (half a second at 30 fps). */
const SETTLE_FRAMES = 15;
/** A face gone this long is someone new: centre on them when they appear. */
const NEW_PERSON_MS = 2000;
/** Blink score that means the eyes are really closed (looking down scores well below this). */
const CLOSED = 0.6;

type Pt = { x: number; y: number };

export class NoseCursor {
  private centre: Pt | null = null;
  private settling: Pt[] = [];
  private lastSeen = -Infinity;
  private last: Pt | null = null;
  private fx = new OneEuroFilter({ minCutoff: 0.9, beta: 2.0, dCutoff: 1.0 });
  private fy = new OneEuroFilter({ minCutoff: 0.9, beta: 2.0, dCutoff: 1.0 });

  /** Start again: the next half second of looking becomes the middle of the screen. */
  recentre(): void {
    this.centre = null;
    this.settling = [];
    this.last = null;
    this.fx.reset();
    this.fy.reset();
  }

  /** The nose position relative to the face, in face widths (x mirrored so turning right moves right). */
  static measure(landmarks: readonly { x: number; y: number }[], aspect: number): Pt | null {
    const n = landmarks[NOSE];
    const l = landmarks[LEFT];
    const r = landmarks[RIGHT];
    if (!n || !l || !r) return null;
    const fw = Math.hypot((r.x - l.x) * aspect, r.y - l.y);
    if (!(fw > 0.02)) return null;
    return { x: ((1 - n.x) * aspect) / fw, y: n.y / fw };
  }

  /**
   * Where the cursor goes, as a fraction of the screen (0..1 each way), or null with no face. `blink` is the face
   * model's eye-closure score.
   */
  update(
    landmarks: readonly { x: number; y: number }[] | null,
    aspect: number,
    t: number,
    blink: number | null,
  ): Pt | null {
    const m = landmarks ? NoseCursor.measure(landmarks, aspect) : null;
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
    const sx = clamp(0.5 + (m.x - this.centre.x) * NOSE_GAIN.x);
    const sy = clamp(0.5 + (m.y - this.centre.y) * NOSE_GAIN.y);
    this.last = { x: clamp(this.fx.filter(sx, t)), y: clamp(this.fy.filter(sy, t)) };
    return this.last;
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
