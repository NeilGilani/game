/**
 * A finished eye calibration as the web app keeps it (localStorage, or sessionStorage for this
 * session only): the gaze engine's model and its measured quality, plus the viewport it was made
 * in. Training frames are dropped before storing: the engine doesn't need them, and nothing about
 * the person's face is kept beyond the fitted numbers.
 */

import type { CalibrationResult } from "../../../os/gaze/src/calibration/session";

export interface StoredCalibration {
  version: 2;
  /** Viewport size (CSS pixels) during calibration: the space the model predicts in. */
  width: number;
  height: number;
  createdAt: string;
  result: CalibrationResult;
}

export function storeCalibration(
  result: CalibrationResult,
  width: number,
  height: number,
): StoredCalibration {
  return {
    version: 2,
    width: Math.round(width),
    height: Math.round(height),
    createdAt: new Date().toISOString(),
    result: { ...result, samples: [] },
  };
}

const GRADES = new Set(["good", "fair", "poor"]);

/** Shape check for what comes back from storage (older calibrations, corrupt data, other apps). */
export function isStoredCalibration(value: unknown): value is StoredCalibration {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<StoredCalibration>;
  if (v.version !== 2 || typeof v.createdAt !== "string") return false;
  if (!(typeof v.width === "number" && v.width > 0 && typeof v.height === "number" && v.height > 0))
    return false;
  const r = v.result as Partial<CalibrationResult> | undefined;
  if (!r || typeof r !== "object" || !r.model || !r.quality) return false;
  if (r.model.version !== 2 || !Array.isArray(r.model.parts) || r.model.parts.length === 0) return false;
  return GRADES.has(r.quality.grade) && typeof r.quality.meanErrorPt === "number";
}

/** "about 70 px (2.0°)": the measured error on dots the model never trained on. */
export function describeError(calibration: StoredCalibration): string {
  const q = calibration.result.quality;
  const px = `about ${Math.round(q.meanErrorPt)} px`;
  return q.meanErrorDeg === null ? px : `${px} (${q.meanErrorDeg.toFixed(1)}°)`;
}

/** The worst of the check dots, px. */
export function worstError(calibration: StoredCalibration): number {
  return Math.round(Math.max(0, ...calibration.result.validation.map((v) => v.errorPt)));
}
