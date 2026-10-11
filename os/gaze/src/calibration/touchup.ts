/**
 * The 2-second touch-up: one dot, "look at the dot", instead of a full rescan.
 *
 * When everyday selections keep landing off the same way by a lot (continuous.ts asks for it), the
 * host shows a dot (the middle of the display by default) for 2 seconds. The first 0.7 s give the
 * eyes time to land; the median uncorrected estimate over the rest says where this person's gaze
 * now lands for that dot, and the engine shifts the correction so the dot is hit (keeping the
 * scan's model, its slope and the head terms). If the eyes didn't settle on the dot (a blink
 * through it, a glance away), the touch-up fails and changes nothing.
 *
 * Pure logic, like PursuitCalibration: the host draws the dot and the engine hands in each frame.
 * Tests: tests/touchup.test.ts.
 */

import { HEAD_TERMS } from "./head";

export interface TouchUpOptions {
  /** Where the dot is (the engine's points). */
  target: { x: number; y: number };
  durationMs?: number;
  /** Time for the eyes to find the dot before frames count. */
  settleMs?: number;
  /** Usable frames needed. */
  minFrames?: number;
  /** Frames must agree within this (median distance from their median, points). Single webcam frames
   * scatter 100 to 200 points around a steady fixation; eyes that wandered off the dot scatter far more. */
  maxSpreadPt?: number;
}

export type TouchUpResult =
  | {
      kind: "done";
      target: { x: number; y: number };
      /** Median uncorrected estimate while looking at the dot. */
      estimate: { x: number; y: number };
      /** Median head pose change since the scan. */
      z: number[];
      frames: number;
      spreadPt: number;
    }
  | { kind: "failed"; reason: string };

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

export class TouchUp {
  readonly target: { x: number; y: number };
  readonly durationMs: number;
  private readonly settleMs: number;
  private readonly minFrames: number;
  private readonly maxSpreadPt: number;
  private frames: { x: number; y: number; z: readonly number[] }[] = [];

  constructor(options: TouchUpOptions) {
    this.target = options.target;
    this.durationMs = options.durationMs ?? 2000;
    this.settleMs = options.settleMs ?? 700;
    this.minFrames = options.minFrames ?? 10;
    this.maxSpreadPt = options.maxSpreadPt ?? 300;
  }

  /** A frame `ms` after the dot appeared: the uncorrected estimate (null if none) and the head change. */
  add(
    ms: number,
    estimate: { x: number; y: number } | null,
    z: readonly number[] | null,
    confidence: number,
    blink: number | null,
  ): void {
    if (ms < this.settleMs || ms > this.durationMs) return;
    if (!estimate || confidence < 0.5 || (blink ?? 0) >= 0.4) return;
    this.frames.push({ x: estimate.x, y: estimate.y, z: z ?? [0, 0, 0, 0, 0] });
  }

  finish(): TouchUpResult {
    if (this.frames.length < this.minFrames) {
      return { kind: "failed", reason: "Your eyes weren't seen clearly on the dot. We'll try again later." };
    }
    const estimate = { x: median(this.frames.map((f) => f.x)), y: median(this.frames.map((f) => f.y)) };
    const spreadPt = median(this.frames.map((f) => Math.hypot(f.x - estimate.x, f.y - estimate.y)));
    if (spreadPt > this.maxSpreadPt) {
      return { kind: "failed", reason: "Your eyes moved around during the dot. We'll try again later." };
    }
    const z = HEAD_TERMS.map((_, k) => median(this.frames.map((f) => f.z[k] ?? 0)));
    return { kind: "done", target: this.target, estimate, z, frames: this.frames.length, spreadPt };
  }
}
