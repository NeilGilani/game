/** Shared test helpers: synthetic people and quick engine runs. All data here is simulated. */

import { CalibrationSession } from "../src/calibration/session";
import {
  MACBOOK_DISPLAY,
  type NoiseModel,
  SyntheticFace,
  TYPICAL_NOISE,
  WEBCAM_640,
  randomAnatomy,
} from "../src/synth/face";
import { driveCalibration } from "../src/synth/drive";
import { HeadMotion, type HeadMotionKind } from "../src/synth/scenarios";

export const DISPLAY = { x: 0, y: 0, width: MACBOOK_DISPLAY.widthPt, height: MACBOOK_DISPLAY.heightPt };

export function person(seed: number, noise: NoiseModel = TYPICAL_NOISE): SyntheticFace {
  return new SyntheticFace(randomAnatomy(seed), MACBOOK_DISPLAY, WEBCAM_640, noise, seed);
}

export function calibrate(seed: number, kind: HeadMotionKind = "still", noise: NoiseModel = TYPICAL_NOISE) {
  const face = person(seed, noise);
  const session = new CalibrationSession({ display: DISPLAY });
  const head = new HeadMotion({ kind, seed });
  const run = driveCalibration(face, session, head, DISPLAY, { seed });
  return { face, head, run };
}
