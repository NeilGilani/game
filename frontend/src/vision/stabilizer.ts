/**
 * Makes webcam gaze feel steady. Webcam eye tracking is noisy: even after the One Euro filter the estimate
 * wanders tens of pixels while the eyes rest on one thing. Real eyes alternate between fixations (still) and
 * saccades (fast jumps), so the pointer should too:
 *
 * - While new estimates stay within `radius` of the pointer, it is a fixation: the pointer holds still and only
 *   drifts slowly toward the average (so a slightly-off fixation is corrected without visible jitter).
 * - When estimates land outside the radius for `confirmFrames` frames in a row, it is a saccade: the pointer
 *   moves quickly to the new place. A single wild frame (a blink, a tracking glitch) is ignored.
 *
 * Pure and deterministic; unit-tested in tests/stabilizer.test.ts.
 */

export interface StabilizerOptions {
  /** Fixation radius in pixels: wobble inside it doesn't move the pointer. */
  radius: number;
  /** Fraction of the remaining distance the pointer drifts per frame while fixating (0..1). */
  drift: number;
  /** Fraction of the remaining distance the pointer covers per frame during a saccade (0..1). */
  jump: number;
  /** Frames outside the radius before it counts as a real move, not noise. */
  confirmFrames: number;
}

export const DEFAULT_STABILIZER: StabilizerOptions = {
  radius: 60,
  drift: 0.06,
  jump: 0.55,
  confirmFrames: 2,
};

type Point = { x: number; y: number };

export class GazeStabilizer {
  private options: StabilizerOptions;
  private pointer: Point | null = null;
  private outside = 0;
  private moving = false;
  private target: Point | null = null;

  constructor(options: Partial<StabilizerOptions> = {}) {
    this.options = { ...DEFAULT_STABILIZER, ...options };
  }

  setOptions(options: Partial<StabilizerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.pointer = null;
    this.outside = 0;
    this.moving = false;
    this.target = null;
  }

  update(p: Point): Point {
    const o = this.options;
    if (!this.pointer) {
      this.pointer = { ...p };
      return { ...p };
    }
    const d = Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y);
    if (this.moving) {
      // Follow the new place until the pointer has arrived, then settle into a fixation.
      this.target = p;
      this.step(p, o.jump);
      if (Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y) < o.radius * 0.5) this.moving = false;
      return { ...this.pointer };
    }
    if (d > o.radius) {
      this.outside += 1;
      this.target = this.target ? { x: (this.target.x + p.x) / 2, y: (this.target.y + p.y) / 2 } : { ...p };
      if (this.outside >= o.confirmFrames) {
        this.moving = true;
        this.outside = 0;
        this.step(this.target, o.jump);
      }
      return { ...this.pointer };
    }
    this.outside = 0;
    this.target = null;
    this.step(p, o.drift);
    return { ...this.pointer };
  }

  private step(to: Point, k: number): void {
    if (!this.pointer) return;
    this.pointer = {
      x: this.pointer.x + (to.x - this.pointer.x) * k,
      y: this.pointer.y + (to.y - this.pointer.y) * k,
    };
  }
}
