/**
 * Runs calibration against a synthetic person, exactly as a host would against a real one, and
 * keeps the raw features so the old (v1) pipeline can be scored on the very same frames.
 */

import { type GazeInput, gazeInput } from "../calibration/features";
import { type CalibrationSample, featureVector } from "../calibration/legacy";
import { type CalibrationSession, type SessionStep } from "../calibration/session";
import { type GazeFeatures, extractFeatures } from "../landmarks";
import type { SyntheticFace } from "./face";
import { GazeScript, type HeadMotion, simulate } from "./scenarios";

export interface DriveOptions {
  settleMs?: number;
  collectMs?: number;
  seed?: number;
  startMs?: number;
}

export interface DriveResult {
  step: SessionStep;
  endMs: number;
  /** v1-style samples for the same training targets (targets normalised to the display). */
  legacyTraining: CalibrationSample[];
  /** Raw features per validation target, for scoring any model on the held-out pass. */
  validationFrames: { x: number; y: number; features: GazeFeatures[] }[];
}

export function driveCalibration(
  face: SyntheticFace,
  session: CalibrationSession,
  head: HeadMotion,
  display: { x: number; y: number; width: number; height: number },
  options: DriveOptions = {},
): DriveResult {
  const settle = options.settleMs ?? 800;
  const collect = options.collectMs ?? 1100;
  let t = options.startMs ?? 0;
  let prev = { x: display.x + display.width / 2, y: display.y + display.height / 2 };
  const legacyTraining: CalibrationSample[] = [];
  const validationFrames: DriveResult["validationFrames"] = [];
  let seed = options.seed ?? 1;
  for (let guard = 0; guard < 60; guard++) {
    const step = session.next();
    if (step.kind !== "target") return { step, endMs: t, legacyTraining, validationFrames };
    const target = step.target;
    const script = new GazeScript(
      [
        { x: prev.x, y: prev.y, durationMs: 1 },
        { x: target.x, y: target.y, durationMs: settle + collect },
      ],
      { seed: seed++ },
    );
    const inputs: GazeInput[] = [];
    const raw: GazeFeatures[] = [];
    for (const f of simulate(face, script, head, { startMs: t, seed })) {
      if (f.t - t < settle) continue;
      const features = extractFeatures(f.frame.landmarks, f.frame.aspect, f.frame.matrix);
      if (!features || f.frame.blinkScore > 0.4) continue;
      inputs.push(gazeInput(features));
      raw.push(features);
    }
    t += script.totalMs + 200;
    prev = target;
    session.addSamples(target.id, inputs);
    const nt = { x: (target.x - display.x) / display.width, y: (target.y - display.y) / display.height };
    if (target.phase === "train") {
      for (const f of raw) legacyTraining.push({ target: nt, features: featureVector(f, "gaze") });
    } else {
      validationFrames.push({ x: target.x, y: target.y, features: raw });
    }
  }
  return { step: { kind: "failed", reason: "too many targets" }, endMs: t, legacyTraining, validationFrames };
}
