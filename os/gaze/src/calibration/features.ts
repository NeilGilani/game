/**
 * Calibration v2 inputs: a compact, serialisable record of everything the model may use from one
 * frame, so samples can be stored, replayed and refitted (continuous recalibration).
 */

import type { EyeFeatures, GazeFeatures } from "../landmarks";
import { type Mat3, type Vec3, add3, mulMat3Vec, scale3 } from "../linalg";

export interface EyeInput {
  /** Centred iris position in the eye (0 = middle), in eye widths. Head rotation removed when possible. */
  h: number;
  v: number;
  /** Ray from this eye hitting the display plane, camera frame, cm (nominal anatomy). Null if unknown. */
  gx: number | null;
  gy: number | null;
}

export interface GazeInput {
  left: EyeInput | null;
  right: EyeInput | null;
  /** Head pose in degrees (MediaPipe matrix convention, or the landmark estimate). */
  yaw: number;
  pitch: number;
  roll: number;
  /** Head position, cm, when the transformation matrix is available; else a nose/face-size proxy. */
  tx: number;
  ty: number;
  tz: number;
  /** True when eye features have the head rotation removed and tx..tz are centimetres. */
  normalized: boolean;
  /** Iris diameter as a fraction of image width (for viewing distance). */
  irisDiameter: number;
}

/** Nominal anatomy for the geometric feature. Errors here are absorbed by the regression. */
export const NOMINAL_EYE = { eyeballRadiusCm: 1.2, eyeWidthCm: 3.0, interocularCm: 6.3 };

/**
 * Where a ray from the eye meets the display plane (z = 0), in camera coordinates (cm), using a
 * simple eyeball model: the iris sits on a sphere, so its offset in eye widths gives the angle.
 */
export function eyeRayOnScreen(
  eye: { h: number; v: number },
  side: "left" | "right",
  rotation: Mat3,
  translationCm: Vec3,
): { x: number; y: number } | null {
  const k = NOMINAL_EYE.eyeWidthCm / NOMINAL_EYE.eyeballRadiusCm;
  const sx = Math.max(-0.95, Math.min(0.95, eye.h * k));
  const sy = Math.max(-0.95, Math.min(0.95, eye.v * k));
  const sz = 1 - sx * sx - sy * sy;
  if (sz <= 0.01) return null;
  const dirHead: Vec3 = [sx, sy, -Math.sqrt(sz)];
  const offset: Vec3 = [((side === "right" ? -1 : 1) * NOMINAL_EYE.interocularCm) / 2, 0, 0];
  const origin = add3(translationCm, mulMat3Vec(rotation, offset));
  const dir = mulMat3Vec(rotation, dirHead);
  if (dir[2] > -0.05) return null;
  const s = -origin[2] / dir[2];
  const hit = add3(origin, scale3(dir, s));
  return { x: hit[0], y: hit[1] };
}

function eyeInput(
  normalized: EyeFeatures | null,
  raw: EyeFeatures,
  side: "left" | "right",
  f: GazeFeatures,
): EyeInput {
  if (normalized && f.rotation && f.translationCm) {
    const ray = eyeRayOnScreen(normalized, side, f.rotation, f.translationCm);
    return { h: normalized.h, v: normalized.v, gx: ray?.x ?? null, gy: ray?.y ?? null };
  }
  return { h: raw.h - 0.5, v: raw.v, gx: null, gy: null };
}

/**
 * Model input from extracted features. An eye that looks closed (openness well below the other)
 * is dropped, so a wink, a droopy lid or a reflection on one side doesn't drag the estimate.
 */
export function gazeInput(f: GazeFeatures): GazeInput {
  const normalized = !!(f.rotation && f.translationCm && f.leftN && f.rightN);
  let left: EyeInput | null = eyeInput(normalized ? f.leftN : null, f.left, "left", f);
  let right: EyeInput | null = eyeInput(normalized ? f.rightN : null, f.right, "right", f);
  const lo = f.left.openness;
  const ro = f.right.openness;
  if (lo < 0.5 * ro) left = null;
  else if (ro < 0.5 * lo) right = null;
  const t = f.translationCm;
  return {
    left,
    right,
    yaw: f.pose.yaw,
    pitch: f.pose.pitch,
    roll: f.pose.roll,
    tx: t ? t[0] : f.nose.x * 30,
    ty: t ? t[1] : f.nose.y * 30,
    tz: t ? t[2] : 4 / Math.max(f.faceScale, 0.02),
    normalized,
    irisDiameter: f.irisDiameter,
  };
}
