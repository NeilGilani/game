/**
 * Head pointer: for people who can move their head a little but find eye gaze unreliable, the
 * pointer follows the head's rotation (like a head mouse). No calibration dots: the pose when
 * the person starts (or asks to recentre) points at the centre of the display, and a gain maps
 * degrees of head turn to points. Smoothed with a One Euro filter, since heads move smoothly.
 */

import type { HeadPose } from "./landmarks";
import { OneEuroFilter } from "./oneEuro";

export interface HeadPointerOptions {
  /** Degrees of head turn from centre to the display's edge. Smaller = less movement needed. */
  rangeDeg: { x: number; y: number };
  /** Degrees ignored around the centre pose (tremor). */
  deadZoneDeg: number;
  /** Set if the pointer moves the wrong way for this camera (the sign depends on mirroring). */
  invertX: boolean;
  invertY: boolean;
}

export const DEFAULT_HEAD_POINTER: HeadPointerOptions = {
  rangeDeg: { x: 14, y: 10 },
  deadZoneDeg: 0.4,
  invertX: false,
  invertY: false,
};

export class HeadPointer {
  private o: HeadPointerOptions;
  private neutral: HeadPose | null = null;
  private fx = new OneEuroFilter({ minCutoff: 1.2, beta: 0.02, dCutoff: 1 });
  private fy = new OneEuroFilter({ minCutoff: 1.2, beta: 0.02, dCutoff: 1 });

  constructor(
    private bounds: { x: number; y: number; width: number; height: number },
    options: Partial<HeadPointerOptions> = {},
  ) {
    this.o = { ...DEFAULT_HEAD_POINTER, ...options };
  }

  setOptions(options: Partial<HeadPointerOptions>): void {
    this.o = { ...this.o, ...options };
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }

  /** The current pose becomes "pointing at the centre". */
  recentre(): void {
    this.neutral = null;
    this.fx.reset();
    this.fy.reset();
  }

  update(t: number, pose: HeadPose): { x: number; y: number } {
    this.neutral ??= pose;
    const dz = (v: number) => (Math.abs(v) <= this.o.deadZoneDeg ? 0 : v - Math.sign(v) * this.o.deadZoneDeg);
    // Yaw (MediaPipe matrix convention) grows as the head turns to the person's left. Checked on the
    // synthetic face; if a real camera shows otherwise, invertX fixes it without code changes.
    const sx = this.o.invertX ? 1 : -1;
    const sy = this.o.invertY ? -1 : 1;
    const nx = (sx * dz(pose.yaw - this.neutral.yaw)) / this.o.rangeDeg.x;
    const ny = (sy * dz(pose.pitch - this.neutral.pitch)) / this.o.rangeDeg.y;
    const b = this.bounds;
    const x = b.x + b.width * (0.5 + Math.max(-0.5, Math.min(0.5, nx / 2)));
    const y = b.y + b.height * (0.5 + Math.max(-0.5, Math.min(0.5, ny / 2)));
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
}
