/**
 * Viewing distance and visual angle. The iris is close to 11.7 mm across in almost all adults,
 * so its size in the image gives the distance to the camera once the camera's field of view is
 * known. The field of view is an assumption (MacBook FaceTime cameras are roughly 60 to 65
 * degrees horizontally) unless the host supplies it, so degrees are estimates and say so.
 */

import { median } from "../linalg";

export const IRIS_DIAMETER_MM = 11.7;

export interface ViewingGeometry {
  /** Camera horizontal field of view, degrees. */
  cameraHfovDeg: number;
  /** Physical size of one screen point, mm. */
  mmPerPt: number;
  /** Whether those two numbers were measured for this Mac or are defaults. */
  source: "assumed" | "measured";
}

export const DEFAULT_GEOMETRY: ViewingGeometry = { cameraHfovDeg: 62, mmPerPt: 0.197, source: "assumed" };

/** Viewing distance in cm from iris diameters (fractions of image width), or null if implausible. */
export function viewingDistanceCm(
  irisDiameters: readonly number[],
  geometry = DEFAULT_GEOMETRY,
): number | null {
  const d = median(irisDiameters.filter((v) => v > 0 && Number.isFinite(v)));
  if (!Number.isFinite(d) || d <= 0) return null;
  const fx = 1 / (2 * Math.tan((geometry.cameraHfovDeg * Math.PI) / 360));
  const cm = (fx * IRIS_DIAMETER_MM) / 10 / d;
  return cm >= 15 && cm <= 200 ? cm : null;
}

/** Visual angle in degrees of an on-screen distance seen from `distanceCm`. */
export function pointsToDegrees(points: number, distanceCm: number, geometry = DEFAULT_GEOMETRY): number {
  const cm = (points * geometry.mmPerPt) / 10;
  return (Math.atan2(cm, distanceCm) * 180) / Math.PI;
}

export function degreesToPoints(degrees: number, distanceCm: number, geometry = DEFAULT_GEOMETRY): number {
  const cm = Math.tan((degrees * Math.PI) / 180) * distanceCm;
  return (cm * 10) / geometry.mmPerPt;
}

export type Grade = "good" | "fair" | "poor";

/**
 * Honest grades in terms of what a person can do. The OS's smallest normal target is 96 pt, so a
 * mean error under two thirds of that lands directly on targets most of the time; under 128 pt
 * the big Home tiles work and smaller targets need snapping, the picker or the magnifier; above
 * that, eye control will often miss and calibration should be redone (or another input used).
 */
export const GOOD_ERROR_PT = 64;
export const FAIR_ERROR_PT = 128;

export function gradeForPoints(meanErrorPt: number): Grade {
  if (meanErrorPt <= GOOD_ERROR_PT) return "good";
  if (meanErrorPt <= FAIR_ERROR_PT) return "fair";
  return "poor";
}
