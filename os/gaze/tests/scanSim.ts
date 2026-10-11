/**
 * A simulated person doing the 5-second eye scan and its check dots, and the error of the result
 * on fixations at points neither ever showed. Everything here is simulated (synthetic face and
 * synthetic eye images), so it compares ways of doing the scan; it doesn't promise real accuracy.
 */

import { predictBlend } from "../src/calibration/appearance";
import { ScanCheck } from "../src/calibration/check";
import { gazeInput } from "../src/calibration/features";
import { predictModel } from "../src/calibration/model";
import { type PursuitOptions, PursuitCalibration } from "../src/calibration/pursuit";
import type { CalibrationResult } from "../src/calibration/session";
import { extractFeatures } from "../src/landmarks";
import { trackingConfidence } from "../src/quality";
import { SyntheticEyeImages } from "../src/synth/eyes";
import type { HeadState } from "../src/synth/face";
import { HeadMotion } from "../src/synth/scenarios";
import { DISPLAY, person } from "./helpers";

export interface SimOptions {
  seed: number;
  /** How far the person's eyes trail the light (ms). */
  lagMs?: number;
  /** Synthetic eye images for RealEye's model, or landmarks only. */
  eyes?: boolean;
  /** Head moved sideways by this much (cm) after the glide: a real offset for the check to find. */
  shiftCm?: number;
  scan?: Omit<PursuitOptions, "display">;
}

type Point = { x: number; y: number };

export function simulate(o: SimOptions) {
  const face = person(o.seed);
  const images = new SyntheticEyeImages(face, o.seed);
  const motion = new HeadMotion({ kind: "still", seed: o.seed });
  const head = (ms: number, moved: boolean): HeadState => {
    const h = motion.at(ms);
    if (!moved || !o.shiftCm) return h;
    return { ...h, position: [h.position[0] + o.shiftCm, h.position[1], h.position[2]] };
  };
  const frame = (gaze: Point, ms: number, moved: boolean) => {
    const input = { gaze, head: head(ms, moved), closure: 0 };
    const f = face.render(input);
    const features = extractFeatures(f.landmarks, f.aspect, f.matrix);
    return {
      features,
      confidence: trackingConfidence(features, f.blinkScore),
      blink: f.blinkScore,
      eyes: o.eyes ? images.render(input, f) : null,
    };
  };

  const scan = new PursuitCalibration({ display: DISPLAY, ...o.scan });
  for (let ms = 0; ms <= scan.durationMs; ms += 33) {
    const r = frame(scan.at(ms - (o.lagMs ?? 100)), ms, false);
    scan.add(ms, r.features, r.confidence, r.blink, r.eyes);
  }
  const started = performance.now();
  const step = scan.finish();
  const fitMs = performance.now() - started;
  if (step.kind !== "done") throw new Error(`scan failed for seed ${o.seed}`);

  /** The three check dots; the eyes reach each about 200 ms after it appears. */
  const check = (result: CalibrationResult = step.result) => {
    const dots = new ScanCheck(result, { display: DISPLAY });
    const before = scan.at(scan.durationMs);
    for (let ms = 0; ms < dots.durationMs; ms += 33) {
      const gaze = ms < 200 ? before : dots.at(ms - 200)!;
      const r = frame(gaze, 7000 + ms, true);
      dots.add(ms, r.features, r.confidence, r.blink, r.eyes);
    }
    return dots.finish();
  };

  /** Mean error (points) over a 5x5 grid of fixations, 15 frames each, as the calibration is used. */
  const heldOut = (
    result: CalibrationResult,
    options: { offset?: boolean; landmarksOnly?: boolean } = {},
  ) => {
    let total = 0;
    let count = 0;
    for (const nx of [0.15, 0.3, 0.5, 0.7, 0.85]) {
      for (const ny of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const target = { x: DISPLAY.width * nx, y: DISPLAY.height * ny };
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let i = 0; i < 15; i++) {
          const r = frame(target, 9000 + i * 33, true);
          const l = predictModel(result.model, gazeInput(r.features!));
          const p = options.landmarksOnly
            ? l
            : predictBlend(l, result.appearance, r.eyes, options.offset === false ? null : result.offset);
          if (!p) continue;
          sx += p.x;
          sy += p.y;
          n += 1;
        }
        total += Math.hypot(sx / n - target.x, sy / n - target.y);
        count += 1;
      }
    }
    return total / count;
  };

  return { result: step.result, fitMs, check, heldOut };
}

export const mean = (values: readonly number[]) => values.reduce((s, v) => s + v, 0) / values.length;
