import { describe, expect, it } from "vitest";
import { predictBlend } from "../src/calibration/appearance";
import { gazeInput } from "../src/calibration/features";
import { predictModel } from "../src/calibration/model";
import { PursuitCalibration } from "../src/calibration/pursuit";
import { EYE_FEATURES } from "../src/eyeImage";
import { extractFeatures } from "../src/landmarks";
import { gaussian, rng } from "../src/linalg";
import { trackingConfidence } from "../src/quality";
import { MACBOOK_DISPLAY, SyntheticFace, TYPICAL_NOISE, WEBCAM_640, randomAnatomy } from "../src/synth/face";
import { HeadMotion } from "../src/synth/scenarios";

const DISPLAY = { x: 0, y: 0, width: MACBOOK_DISPLAY.widthPt, height: MACBOOK_DISPLAY.heightPt };

/**
 * Stand-ins for RealEye's eye-image features. "informative": a fixed random projection of where
 * the eyes look, plus heavy per-pixel noise (each feature alone is mostly noise). "noise": nothing
 * about the gaze at all. Real eye images sit somewhere in between, which is why the scan measures it.
 */
function eyeImages(kind: "informative" | "noise", seed: number) {
  const rand = rng(seed * 7919);
  const basis = Array.from({ length: 3 }, () =>
    Float32Array.from({ length: EYE_FEATURES }, () => gaussian(rand)),
  );
  return (gaze: { x: number; y: number }): Float32Array => {
    const u = (gaze.x / DISPLAY.width) * 2 - 1;
    const v = (gaze.y / DISPLAY.height) * 2 - 1;
    const terms = kind === "informative" ? [u, v, 0.3 * u * v] : [0, 0, 0];
    const out = new Float32Array(EYE_FEATURES);
    for (let i = 0; i < EYE_FEATURES; i++) {
      out[i] =
        terms[0]! * basis[0]![i]! +
        terms[1]! * basis[1]![i]! +
        terms[2]! * basis[2]![i]! +
        2 * gaussian(rand);
    }
    return out;
  };
}

function scan(seed: number, eyes: ((g: { x: number; y: number }) => Float32Array) | null) {
  const face = new SyntheticFace(randomAnatomy(seed), MACBOOK_DISPLAY, WEBCAM_640, TYPICAL_NOISE, seed);
  const head = new HeadMotion({ kind: "still", seed });
  const run = new PursuitCalibration({ display: DISPLAY });
  for (let ms = 0; ms <= run.durationMs; ms += 33) {
    // The eyes trail the light by about 100 ms.
    const gaze = run.at(ms - 100);
    const f = face.render({ gaze, head: head.at(ms), closure: 0 });
    const features = extractFeatures(f.landmarks, f.aspect, f.matrix);
    run.add(ms, features, trackingConfidence(features, f.blinkScore), f.blinkScore, eyes ? eyes(gaze) : null);
  }
  const started = performance.now();
  const step = run.finish();
  return { step, face, head, ms: performance.now() - started };
}

/** Mean error on fixations at grid points the scan never stopped at: landmarks only, and blended. */
function heldOut(
  result: Extract<ReturnType<PursuitCalibration["finish"]>, { kind: "done" }>["result"],
  face: SyntheticFace,
  head: HeadMotion,
  eyes: ((g: { x: number; y: number }) => Float32Array) | null,
) {
  const errors = { landmarks: 0, blended: 0, n: 0 };
  for (const nx of [0.2, 0.4, 0.6, 0.8]) {
    for (const ny of [0.25, 0.5, 0.75]) {
      const target = { x: DISPLAY.width * nx, y: DISPLAY.height * ny };
      const l = { x: 0, y: 0 };
      const b = { x: 0, y: 0 };
      let n = 0;
      for (let i = 0; i < 15; i++) {
        const f = face.render({ gaze: target, head: head.at(9000 + i * 33), closure: 0 });
        const p = predictModel(result.model, gazeInput(extractFeatures(f.landmarks, f.aspect, f.matrix)!));
        if (!p) continue;
        const q = predictBlend(p, result.appearance, eyes ? eyes(target) : null)!;
        l.x += p.x;
        l.y += p.y;
        b.x += q.x;
        b.y += q.y;
        n += 1;
      }
      errors.landmarks += Math.hypot(l.x / n - target.x, l.y / n - target.y);
      errors.blended += Math.hypot(b.x / n - target.x, b.y / n - target.y);
      errors.n += 1;
    }
  }
  return { landmarks: errors.landmarks / errors.n, blended: errors.blended / errors.n };
}

describe("RealEye eye-image model in the 5-second scan (simulated)", () => {
  it("uses eye images that carry the gaze, and the error on new points drops", () => {
    for (const seed of [1, 2, 3]) {
      const eyes = eyeImages("informative", seed);
      const { step, face, head, ms } = scan(seed, eyes);
      expect(step.kind).toBe("done");
      if (step.kind !== "done") continue;
      expect(step.result.appearance).toBeTruthy();
      expect(step.result.appearance!.landmarkWeight).toBeLessThan(1);
      const without = scan(seed, null).step;
      if (without.kind !== "done") throw new Error("scan without eye images failed");
      // The reported (held-out) error is lower than the landmark model's alone.
      expect(step.result.quality.meanErrorPt).toBeLessThan(without.result.quality.meanErrorPt);
      const e = heldOut(step.result, face, head, eyes);
      console.log(
        `seed ${seed}: landmarks ${Math.round(e.landmarks)} pt, with eye images ${Math.round(e.blended)} pt ` +
          `(weight ${step.result.appearance!.landmarkWeight}, fit ${Math.round(ms)} ms)`,
      );
      expect(e.blended).toBeLessThan(e.landmarks);
      expect(ms).toBeLessThan(3000);
    }
  });

  it("ignores eye images that say nothing about the gaze, and changes nothing", () => {
    for (const seed of [1, 2]) {
      const { step } = scan(seed, eyeImages("noise", seed));
      const without = scan(seed, null).step;
      expect(step.kind).toBe("done");
      if (step.kind !== "done" || without.kind !== "done") continue;
      expect(step.result.appearance).toBeNull();
      expect(step.result.quality.meanErrorPt).toBe(without.result.quality.meanErrorPt);
    }
  });

  it("falls back to the landmarks on frames without eye images", () => {
    const p = { x: 100, y: 200 };
    expect(predictBlend(p, null, null)).toEqual(p);
    const model = { version: 1 as const, wx: [1, 0], wy: [0, 1], bx: 10, by: 20 };
    expect(predictBlend(p, { model, landmarkWeight: 0.5 }, null)).toEqual(p);
    expect(predictBlend(p, { model, landmarkWeight: 0.5 }, Float32Array.from([2, 4]))).toEqual({
      x: 56,
      y: 112,
    });
    // Wrong length (a different extractor): ignored rather than mispredicted.
    expect(predictBlend(p, { model, landmarkWeight: 0.5 }, Float32Array.from([2, 4, 6]))).toEqual(p);
  });
});
