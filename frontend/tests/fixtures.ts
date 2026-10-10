/**
 * Synthetic landmark fixtures (NOT live camera data). They place the eye corners, lids and
 * iris rings at known positions so feature extraction can be checked exactly.
 */
import type { Landmark } from "../src/vision/landmarks";
import { LEFT_EYE, NOSE_TIP, RIGHT_EYE } from "../src/vision/landmarks";

export interface FaceSpec {
  /** Iris offset along each eye, as a fraction of eye width (0 = centred). */
  gazeX?: number;
  /** Iris offset perpendicular to the eye, as a fraction of eye width (+ = down). */
  gazeY?: number;
  /** Lid opening as a fraction of eye width. */
  openness?: number;
  centreX?: number;
  centreY?: number;
  eyeWidth?: number;
}

export function syntheticFace(spec: FaceSpec = {}, aspect = 4 / 3): Landmark[] {
  const { gazeX = 0, gazeY = 0, openness = 0.3, centreX = 0.5, centreY = 0.45, eyeWidth = 0.06 } = spec;
  const points: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  // Work in isotropic units (x scaled by aspect), then convert back to normalised x.
  const put = (i: number, xIso: number, y: number) => {
    points[i] = { x: xIso / aspect, y, z: 0 };
  };
  const cx = centreX * aspect;
  const eyes = [
    { idx: RIGHT_EYE, mid: cx - eyeWidth * 1.1 },
    { idx: LEFT_EYE, mid: cx + eyeWidth * 1.1 },
  ];
  for (const { idx, mid } of eyes) {
    const leftCorner = mid - eyeWidth / 2;
    const rightCorner = mid + eyeWidth / 2;
    // Subject's right eye: outer corner is image-left. Subject's left eye: outer is image-right.
    if (idx === RIGHT_EYE) {
      put(idx.outer, leftCorner, centreY);
      put(idx.inner, rightCorner, centreY);
    } else {
      put(idx.inner, leftCorner, centreY);
      put(idx.outer, rightCorner, centreY);
    }
    put(idx.upper, mid, centreY - (openness * eyeWidth) / 2);
    put(idx.lower, mid, centreY + (openness * eyeWidth) / 2);
    const irisX = mid + gazeX * eyeWidth;
    const irisY = centreY + gazeY * eyeWidth;
    const r = eyeWidth * 0.18;
    const ring = idx.iris;
    put(ring[0]!, irisX + r, irisY);
    put(ring[1]!, irisX, irisY - r);
    put(ring[2]!, irisX - r, irisY);
    put(ring[3]!, irisX, irisY + r);
  }
  put(NOSE_TIP, cx, centreY + eyeWidth * 1.5);
  return points;
}
