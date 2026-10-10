import { describe, expect, it } from "vitest";
import {
  CalibrationError,
  calibrationTargets,
  fitCalibration,
  gradeFor,
  isCalibrationModel,
  predict,
  rejectOutliers,
  solve,
  type CalibrationSample,
} from "../src/vision/calibration";

/** Deterministic pseudo-random numbers so tests are repeatable. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Simulated features: iris position varies (noisily) with where the person looks. */
function samplesFor(noise: number, seed = 1, perTarget = 25): CalibrationSample[] {
  const rand = rng(seed);
  const out: CalibrationSample[] = [];
  for (const t of calibrationTargets()) {
    for (let i = 0; i < perTarget; i++) {
      const n = () => (rand() - 0.5) * 2 * noise;
      const h = 0.5 + 0.2 * (t.x - 0.5) + 0.03 * (t.x - 0.5) ** 2 + n();
      const v = 0.07 * (t.y - 0.5) + n() * 0.5;
      const yaw = (rand() - 0.5) * 2;
      const pitch = (rand() - 0.5) * 2;
      out.push({ target: t, features: [h, v, yaw, pitch] });
    }
  }
  return out;
}

describe("linear algebra", () => {
  it("solves a small system", () => {
    const x = solve(
      [
        [2, 1],
        [1, 3],
      ],
      [3, 5],
    );
    expect(x[0]).toBeCloseTo(0.8);
    expect(x[1]).toBeCloseTo(1.4);
  });
});

describe("calibration fitting", () => {
  it("learns a clean mapping with good quality", () => {
    const model = fitCalibration(samplesFor(0.002), "gaze", { width: 1440, height: 900 });
    expect(model.quality.grade).toBe("good");
    expect(model.quality.meanError).toBeLessThan(0.05);
    const p = predict(model, [0.5 + 0.2 * 0.2 + 0.03 * 0.04, 0.07 * -0.3, 0, 0]);
    expect(p.x).toBeCloseTo(0.7, 1);
    expect(p.y).toBeCloseTo(0.2, 1);
    expect(isCalibrationModel(model)).toBe(true);
  });

  it("reports poor quality for noisy data instead of pretending", () => {
    const model = fitCalibration(samplesFor(0.08), "gaze", { width: 1440, height: 900 });
    expect(model.quality.grade).toBe("poor");
    expect(model.quality.perTarget).toHaveLength(9);
  });

  it("refuses to calibrate from too few targets", () => {
    const few = samplesFor(0.002).filter((s) => s.target.y === 0.5);
    expect(() => fitCalibration(few, "gaze", { width: 1, height: 1 })).toThrow(CalibrationError);
  });

  it("drops outlier frames such as blinks", () => {
    const samples = samplesFor(0.002, 3, 20);
    const corrupted = [...samples, { target: samples[0]!.target, features: [5, 5, 40, 40] }];
    expect(rejectOutliers(corrupted)).toHaveLength(samples.length);
  });

  it("grades thresholds", () => {
    expect(gradeFor(0.05)).toBe("good");
    expect(gradeFor(0.15)).toBe("fair");
    expect(gradeFor(0.3)).toBe("poor");
  });

  it("rejects malformed stored calibration", () => {
    expect(isCalibrationModel({ version: 1, set: "gaze", wx: [1], wy: [1, 2], mean: [], std: [] })).toBe(
      false,
    );
    expect(isCalibrationModel(null)).toBe(false);
  });

  it("visits nine targets starting at the centre", () => {
    const targets = calibrationTargets();
    expect(targets).toHaveLength(9);
    expect(targets[0]).toEqual({ x: 0.5, y: 0.5 });
  });
});
