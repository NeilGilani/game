/**
 * The check after the 5-second eye scan: three quick dots, half a second each (1.5 s in all),
 * at places the scan's light never crossed. They measure the calibration as it will actually be
 * used (the blend of the face-point and eye-image models, augmentation included) on points it
 * never trained on, which the scan's own cross-validation can only estimate.
 *
 * They also fix what's left of a constant offset (the whole estimate sitting a little left, say,
 * because the head moved or the eye images shifted). The offset is the mean of the dots' errors,
 * judged on dots it was not measured on: each dot is corrected with the offset from the other two.
 * It is used only if that helps, and in full only if it halves the error; in between it is scaled
 * down, because with three dots a small apparent gain is often noise (in simulation, applying it
 * whenever it seemed to help made people without a real offset worse). The reported error is the
 * held-out one, with the offset as applied, never the error of the dots it was fitted to.
 *
 * Pure logic, like PursuitCalibration: the host draws the dot at `at(ms)` and hands in each frame
 * with `add(ms, ...)`. Tests: tests/check.test.ts.
 */

import type { GazeFeatures } from "../landmarks";
import { predictBlend } from "./appearance";
import { gazeInput } from "./features";
import { predictModel } from "./model";
import type { Bounds, CalibrationResult, ValidationResult } from "./session";
import { gradeForPoints, pointsToDegrees } from "./viewing";

/** Where the check dots sit (0..1 of the display), between the scan's rows. */
const DOTS: readonly (readonly [number, number])[] = [
  [0.25, 0.3],
  [0.75, 0.3],
  [0.5, 0.72],
];

export interface CheckOptions {
  display: Bounds;
  /** How long each dot shows (ms). */
  dotMs?: number;
  /** Frames from the first part of each dot are ignored: the eyes are still on their way (ms). */
  settleMs?: number;
}

export interface CheckReport {
  /** Each dot and its error before any correction (median estimate to dot). */
  dots: ValidationResult[];
  /** Mean error over the dots, before any correction (points). */
  measuredPt: number;
  /** The offset applied to every estimate from now on (scaled as above), or null when it didn't help. */
  offset: { x: number; y: number } | null;
  /** Mean error with the offset as applied, each dot corrected by the offset of the others (points). */
  correctedPt: number;
  /** The error that applies now: correctedPt when the offset is used, measuredPt when not. */
  usedPt: number;
  /** What the scan's cross-validation had estimated, for comparison (points). */
  scanEstimatePt: number;
}

type Point = { x: number; y: number };

/** The offset is applied in full when it cuts the held-out error by this much, scaled down below. */
const FULL_GAIN = 0.5;

const median = (values: number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
};

export class ScanCheck {
  readonly durationMs: number;
  private readonly dotMs: number;
  private readonly settleMs: number;
  private readonly dots: Point[];
  private readonly seen: Point[][];

  constructor(
    private readonly result: CalibrationResult,
    options: CheckOptions,
  ) {
    const d = options.display;
    this.dotMs = options.dotMs ?? 500;
    this.settleMs = options.settleMs ?? 250;
    this.durationMs = this.dotMs * DOTS.length;
    this.dots = DOTS.map(([u, v]) => ({ x: d.x + d.width * u, y: d.y + d.height * v }));
    this.seen = this.dots.map(() => []);
  }

  /** The dot showing `ms` after the check started, or null once it's over. */
  at(ms: number): Point | null {
    const i = Math.floor(Math.max(0, ms) / this.dotMs);
    return i < this.dots.length ? { ...this.dots[i]! } : null;
  }

  /** A camera frame seen `ms` after the check started. Blinks and poorly tracked frames are skipped. */
  add(
    ms: number,
    features: GazeFeatures | null,
    confidence: number,
    blink: number | null,
    eyes?: Float32Array | null,
  ): void {
    const i = Math.floor(ms / this.dotMs);
    if (i < 0 || i >= this.dots.length || ms - i * this.dotMs < this.settleMs) return;
    if (!features || confidence < 0.5 || (blink ?? 0) >= 0.4) return;
    const p = predictBlend(
      predictModel(this.result.model, gazeInput(features)),
      this.result.appearance,
      eyes,
    );
    if (p) this.seen[i]!.push(p);
  }

  /**
   * The calibration with what the dots measured: its quality is now the measured error, and the
   * offset is included when it helped. Unchanged, with `check: null`, if fewer than two dots were
   * seen clearly (the reported quality stays the scan's estimate).
   */
  finish(): CalibrationResult {
    const measured = this.dots.flatMap((dot, i) => {
      const seen = this.seen[i]!;
      if (seen.length < 3) return [];
      const mx = median(seen.map((p) => p.x));
      const my = median(seen.map((p) => p.y));
      const spread = Math.sqrt(seen.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / seen.length);
      return [{ dot, error: { x: mx - dot.x, y: my - dot.y }, precisionPt: spread, samples: seen.length }];
    });
    if (measured.length < 2) return { ...this.result, check: null };
    const n = measured.length;
    const measuredPt = measured.reduce((s, m) => s + Math.hypot(m.error.x, m.error.y), 0) / n;
    // Each dot corrected by the mean error of the others: how much the offset helps on new points.
    const sum = measured.reduce((s, m) => ({ x: s.x + m.error.x, y: s.y + m.error.y }), { x: 0, y: 0 });
    const heldOut = (scale: number) =>
      measured.reduce((s, m) => {
        const ox = (scale * (sum.x - m.error.x)) / (n - 1);
        const oy = (scale * (sum.y - m.error.y)) / (n - 1);
        return s + Math.hypot(m.error.x - ox, m.error.y - oy);
      }, 0) / n;
    const gain = 1 - heldOut(1) / measuredPt;
    const scale = Math.min(1, Math.max(0, gain / FULL_GAIN));
    const offset = scale > 0 ? { x: (-scale * sum.x) / n, y: (-scale * sum.y) / n } : null;
    const correctedPt = heldOut(scale);
    const usedPt = offset ? correctedPt : measuredPt;
    const distanceCm = this.result.distanceCm;
    const check: CheckReport = {
      dots: measured.map((m) => ({
        x: m.dot.x,
        y: m.dot.y,
        errorPt: Math.hypot(m.error.x, m.error.y),
        precisionPt: m.precisionPt,
        samples: m.samples,
      })),
      measuredPt,
      offset,
      correctedPt,
      usedPt,
      scanEstimatePt: this.result.quality.meanErrorPt,
    };
    return {
      ...this.result,
      quality: {
        ...this.result.quality,
        grade: gradeForPoints(usedPt),
        meanErrorPt: usedPt,
        meanErrorDeg: distanceCm === null ? null : pointsToDegrees(usedPt, distanceCm, this.result.geometry),
      },
      validation: check.dots,
      offset,
      check,
    };
  }
}
