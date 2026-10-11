/** Shared test helpers: synthetic people and quick engine runs. All data here is simulated. */

import { PursuitCalibration } from "../src/calibration/pursuit";
import { CalibrationSession } from "../src/calibration/session";
import { GazeEngine } from "../src/engine";
import { extractFeatures } from "../src/landmarks";
import type { ProviderFrame } from "../src/providers/types";
import { trackingConfidence } from "../src/quality";
import { singleDisplay } from "../src/screen";
import {
  MACBOOK_DISPLAY,
  type NoiseModel,
  SyntheticFace,
  TYPICAL_NOISE,
  WEBCAM_640,
  randomAnatomy,
} from "../src/synth/face";
import { driveCalibration } from "../src/synth/drive";
import {
  GazeScript,
  HeadMotion,
  type HeadMotionKind,
  type HeadSource,
  type SimFrame,
  simulate,
} from "../src/synth/scenarios";

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

/**
 * A GazeEngine calibrated with the 5-second eye scan on synthetic person `seed` (head motion `kind`
 * during the scan), as the web app does it. Simulated: no real person or camera.
 */
export function scannedEngine(
  seed: number,
  kind: HeadMotionKind = "still",
  noise: NoiseModel = TYPICAL_NOISE,
) {
  const face = person(seed, noise);
  const head = new HeadMotion({ kind, seed });
  const scan = new PursuitCalibration({ display: DISPLAY });
  for (let ms = 0; ms <= scan.durationMs; ms += 33) {
    // The eyes trail the light by about 100 ms.
    const f = face.render({ gaze: scan.at(ms - 100), head: head.at(ms), closure: 0 });
    const features = extractFeatures(f.landmarks, f.aspect, f.matrix);
    scan.add(ms, features, trackingConfidence(features, f.blinkScore), f.blinkScore);
  }
  const step = scan.finish();
  if (step.kind !== "done") throw new Error(step.kind === "failed" ? step.reason : "scan unfinished");
  const engine = new GazeEngine({ screen: singleDisplay(DISPLAY.width, DISPLAY.height) });
  engine.setCalibration(step.result);
  return { engine, face, head, result: step.result, endMs: scan.durationMs };
}

export const faceFrame = (f: SimFrame): ProviderFrame => ({
  kind: "face",
  frame: {
    t: f.t,
    landmarks: f.frame.landmarks,
    matrix: f.frame.matrix,
    blink: f.frame.blinkScore,
    aspect: f.frame.aspect,
  },
});

/**
 * The person looks at `target` for `ms` from `startMs`; returns the median of the engine's corrected
 * (unsmoothed) estimates after the first 400 ms, or null if there were none.
 */
export function fixate(
  engine: GazeEngine,
  face: SyntheticFace,
  head: HeadSource,
  target: { x: number; y: number },
  startMs: number,
  ms = 1400,
  from?: { x: number; y: number },
): { x: number; y: number } | null {
  const script = new GazeScript(
    [
      { ...(from ?? target), durationMs: 1 },
      { ...target, durationMs: ms },
    ],
    { naturalBlinks: false, seed: Math.round(startMs) },
  );
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of simulate(face, script, head, { startMs, seed: Math.round(startMs) })) {
    engine.handle(faceFrame(f));
    const raw = engine.last?.raw;
    if (raw && f.t - startMs >= 400) {
      xs.push(raw.x);
      ys.push(raw.y);
    }
  }
  if (xs.length === 0) return null;
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  return { x: med(xs), y: med(ys) };
}

/** Held-out fixation targets (the scan never stops at them). */
export const GRID = [0.2, 0.4, 0.6, 0.8].flatMap((nx) =>
  [0.25, 0.5, 0.75].map((ny) => ({ x: DISPLAY.width * nx, y: DISPLAY.height * ny })),
);

/** Mean error (points) of fixations on GRID starting at `startMs`, 1.6 s apart. */
export function gridError(
  engine: GazeEngine,
  face: SyntheticFace,
  head: HeadSource,
  startMs: number,
): number {
  let total = 0;
  let n = 0;
  GRID.forEach((target, i) => {
    const p = fixate(engine, face, head, target, startMs + i * 1600);
    if (!p) return;
    total += Math.hypot(p.x - target.x, p.y - target.y);
    n += 1;
  });
  return n ? total / n : Infinity;
}
