import { describe, expect, it } from "vitest";
import { gazeInput } from "../src/calibration/features";
import { fitCalibration, featureVector, predict } from "../src/calibration/legacy";
import {
  type Sample,
  aggregate,
  crossValidate,
  predictModel,
  rejectOutliers,
  selectModel,
} from "../src/calibration/model";
import { CalibrationSession } from "../src/calibration/session";
import {
  FAIR_ERROR_PT,
  GOOD_ERROR_PT,
  degreesToPoints,
  gradeForPoints,
  pointsToDegrees,
  viewingDistanceCm,
} from "../src/calibration/viewing";
import { extractFeatures } from "../src/landmarks";
import { NO_NOISE } from "../src/synth/face";
import { DISPLAY, calibrate } from "./helpers";

function validationError(
  run: ReturnType<typeof calibrate>["run"],
  predictPt: (f: never) => { x: number; y: number } | null,
) {
  const errs = run.validationFrames.map((v) => {
    const ps = v.features.map((f) => predictPt(f as never)).filter((p) => p !== null);
    const mx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const my = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    return Math.hypot(mx - v.x, my - v.y);
  });
  return errs.reduce((a, b) => a + b, 0) / errs.length;
}

describe("viewing geometry", () => {
  it("converts between points and degrees", () => {
    const pt = degreesToPoints(2, 60);
    expect(pointsToDegrees(pt, 60)).toBeCloseTo(2, 8);
    // 1 degree at 60 cm is about 1.05 cm, about 53 points at 0.197 mm per point.
    expect(degreesToPoints(1, 60)).toBeGreaterThan(50);
    expect(degreesToPoints(1, 60)).toBeLessThan(56);
  });

  it("estimates viewing distance from the iris size", () => {
    const fx = 1 / (2 * Math.tan((62 * Math.PI) / 360));
    const at = (cm: number) => (fx * 1.17) / cm;
    expect(viewingDistanceCm([at(55), at(55), at(56)])).toBeCloseTo(55, 0);
    expect(viewingDistanceCm([0.5])).toBeNull(); // 3 cm away: implausible
    expect(viewingDistanceCm([])).toBeNull();
  });

  it("grades honestly in terms of the 96-point target bar", () => {
    expect(gradeForPoints(GOOD_ERROR_PT)).toBe("good");
    expect(gradeForPoints(GOOD_ERROR_PT + 1)).toBe("fair");
    expect(gradeForPoints(FAIR_ERROR_PT + 1)).toBe("poor");
  });
});

describe("calibration v2 session", () => {
  it("runs 9 to 16 training points, then held-out validation, and reports points and degrees", () => {
    const { run } = calibrate(1);
    expect(run.step.kind).toBe("done");
    if (run.step.kind !== "done") return;
    const r = run.step.result;
    expect(r.trainingTargets).toBeGreaterThanOrEqual(9);
    expect(r.trainingTargets).toBeLessThanOrEqual(16);
    expect(r.validation.length).toBe(4);
    // Validation targets are never training targets.
    const trainGroups = new Set(r.samples.map((s) => s.group));
    expect([...trainGroups].every((g) => g.startsWith("t"))).toBe(true);
    expect(r.quality.meanErrorDeg).not.toBeNull();
    expect(r.distanceCm).toBeGreaterThan(50);
    expect(r.distanceCm).toBeLessThan(70);
    expect(r.quality.grade).toBe(gradeForPoints(r.quality.meanErrorPt));
  });

  it("adds points where the error is worst, and stops at 16", () => {
    const session = new CalibrationSession({ display: DISPLAY, maxPoints: 16 });
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      const step = session.next();
      if (step.kind !== "target") break;
      seen.push(step.target.id);
      // Garbage inputs: calibration can't be good, so it asks for the maximum.
      const inputs = Array.from({ length: 12 }, (_, k) => ({
        left: { h: Math.sin(k + i) * 0.01, v: Math.cos(k * i) * 0.01, gx: null, gy: null },
        right: { h: Math.sin(k + i) * 0.01, v: Math.cos(k * i) * 0.01, gx: null, gy: null },
        yaw: 0,
        pitch: 0,
        roll: 0,
        tx: 0,
        ty: 0,
        tz: 60,
        normalized: false,
        irisDiameter: 0.016,
      }));
      session.addSamples(step.target.id, inputs);
    }
    const train = seen.filter((id) => id.startsWith("t"));
    expect(train.length).toBe(16);
    expect(seen.filter((id) => id.startsWith("v")).length).toBe(4);
    const final = session.next();
    expect(final.kind).toBe("done");
    if (final.kind === "done") expect(final.result.quality.grade).toBe("poor");
  });

  it("shows a target again once when too few frames were usable, and fails kindly with no data", () => {
    const session = new CalibrationSession({ display: DISPLAY });
    const first = session.next();
    if (first.kind !== "target") throw new Error("expected a target");
    session.addSamples(first.target.id, []);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const s = session.next();
      if (s.kind !== "target") {
        expect(s.kind).toBe("failed");
        if (s.kind === "failed") expect(s.reason).toMatch(/try calibration again/);
        break;
      }
      ids.push(s.target.id);
      session.addSamples(s.target.id, []);
    }
    expect(ids.filter((id) => id === first.target.id).length).toBe(1);
  });

  it("fits a near-perfect map from noise-free synthetic eyes", () => {
    const { run } = calibrate(4, "still", NO_NOISE);
    expect(run.step.kind).toBe("done");
    if (run.step.kind === "done") expect(run.step.result.quality.meanErrorPt).toBeLessThan(25);
  });

  it("with the head moving, head-pose normalisation beats the old pipeline (noise-free, so the model is what's compared)", () => {
    let v1Total = 0;
    let v2Total = 0;
    for (const seed of [1, 2, 3]) {
      const { run } = calibrate(seed, "moving", NO_NOISE);
      if (run.step.kind !== "done") throw new Error("calibration failed");
      const model = run.step.result.model;
      const v1 = fitCalibration(run.legacyTraining, "gaze", { width: DISPLAY.width, height: DISPLAY.height });
      v2Total += validationError(run, (f) => predictModel(model, gazeInput(f)));
      v1Total += validationError(run, (f) => {
        const p = predict(v1, featureVector(f, "gaze"));
        return { x: p.x * DISPLAY.width, y: p.y * DISPLAY.height };
      });
    }
    expect(v2Total).toBeLessThan(v1Total * 0.6);
  });
});

describe("model selection", () => {
  // A known quadratic relationship between one feature and the screen.
  const samples: Sample[] = [];
  for (let gx = 0; gx < 4; gx++)
    for (let gy = 0; gy < 4; gy++)
      for (let k = 0; k < 6; k++) {
        const h = (gx - 1.5) * 0.05 + (k - 2.5) * 0.0005;
        const v = (gy - 1.5) * 0.04;
        samples.push({
          x: 700 + 6000 * h + 40000 * h * h,
          y: 450 + 8000 * v,
          group: `g${gx}${gy}`,
          input: {
            left: { h, v, gx: null, gy: null },
            right: { h, v, gx: null, gy: null },
            yaw: 0,
            pitch: 0,
            roll: 0,
            tx: 0,
            ty: 0,
            tz: 60,
            normalized: false,
            irisDiameter: 0.016,
          },
        });
      }

  it("cross-validation picks a curved model for curved data", () => {
    const sel = selectModel(samples, { heads: ["linear"] });
    expect(sel).not.toBeNull();
    expect(sel!.model.config.degree).toBeGreaterThanOrEqual(2);
    expect(sel!.cv.meanErrorPt).toBeLessThan(10);
    const linear = crossValidate(samples, { eye: "binocular", degree: 1, head: "linear", lambda: 0.001 })!;
    expect(linear.meanErrorPt).toBeGreaterThan(sel!.cv.meanErrorPt * 3);
  });

  it("averages frames in chunks within a target only", () => {
    const agg = aggregate(samples, 3);
    expect(agg.length).toBe(32);
    expect(new Set(agg.map((s) => s.group)).size).toBe(16);
  });

  it("drops a glance away from the dot", () => {
    const group = samples.filter((s) => s.group === "g00");
    const glance: Sample = {
      ...group[0]!,
      input: { ...group[0]!.input, left: { h: 0.4, v: 0.3, gx: null, gy: null } },
    };
    const kept = rejectOutliers([...group, glance]);
    expect(kept).not.toContain(glance);
    expect(kept.length).toBe(group.length);
  });
});

describe("features", () => {
  it("drops an eye that looks closed when the other is open", () => {
    const { face } = calibrate(1);
    const frame = face.render({
      gaze: { x: 700, y: 400 },
      head: { position: [0, 14, 60], yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      closure: 0,
    });
    const f = extractFeatures(frame.landmarks, frame.aspect, frame.matrix)!;
    const winking = { ...f, left: { ...f.left, openness: f.right.openness * 0.2 } };
    expect(gazeInput(winking).left).toBeNull();
    expect(gazeInput(winking).right).not.toBeNull();
    expect(gazeInput(f).normalized).toBe(true);
  });
});
