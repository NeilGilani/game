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

/** Which eye model the pointer uses, in plain words. */
export function describeEyeModel(calibration: StoredCalibration): string {
  const r = calibration.result.realEye;
  if (!r) return "Face points only: the camera gave no eye images for RealEye's model. Scan again to add it.";
  const px = (v: number) => `${Math.round(v)} px`;
  if (!calibration.result.appearance)
    return `Face points only: RealEye's eye model measured ${px(r.realEyePt)} against ${px(r.landmarksPt)}, so it's off for now. Scan again in better light.`;
  const share = Math.round(r.realEyeWeight * 100);
  const mix =
    share === 100 ? "RealEye's eye model" : `RealEye's eye model ${share}% + face points ${100 - share}%`;
  return `${mix} (RealEye alone ${px(r.realEyePt)}, face points alone ${px(r.landmarksPt)}, together ${px(r.usedPt)}).`;
}

/** The worst of the check dots, px. */
export function worstError(calibration: StoredCalibration): number {
  return Math.round(Math.max(0, ...calibration.result.validation.map((v) => v.errorPt)));
}
