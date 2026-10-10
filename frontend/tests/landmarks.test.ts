import { FaceLandmarker } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import {
  LEFT_EYE,
  RIGHT_EYE,
  blinkFromBlendshapes,
  extractFeatures,
  headPoseFromMatrix,
} from "../src/vision/landmarks";
import { syntheticFace } from "./fixtures";

const ids = (connections: { start: number; end: number }[]) =>
  new Set(connections.flatMap((c) => [c.start, c.end]));

describe("landmark indices match the installed MediaPipe package", () => {
  it("iris rings", () => {
    expect([...ids(FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS)].sort()).toEqual([...RIGHT_EYE.iris].sort());
    expect([...ids(FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS)].sort()).toEqual([...LEFT_EYE.iris].sort());
  });
  it("eye corners and lids belong to the matching eye contour", () => {
    const right = ids(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE);
    const left = ids(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE);
    for (const i of [RIGHT_EYE.outer, RIGHT_EYE.inner, RIGHT_EYE.upper, RIGHT_EYE.lower])
      expect(right.has(i)).toBe(true);
    for (const i of [LEFT_EYE.outer, LEFT_EYE.inner, LEFT_EYE.upper, LEFT_EYE.lower])
      expect(left.has(i)).toBe(true);
  });
});

describe("feature extraction (synthetic fixtures)", () => {
  const aspect = 4 / 3;
  it("centred iris gives h = 0.5 and v = 0", () => {
    const f = extractFeatures(syntheticFace({}, aspect), aspect)!;
    expect(f.h).toBeCloseTo(0.5, 5);
    expect(f.v).toBeCloseTo(0, 5);
    expect(f.left.h).toBeCloseTo(f.right.h, 5);
  });
  it("iris moving right and down increases h and v in both eyes", () => {
    const f = extractFeatures(syntheticFace({ gazeX: 0.15, gazeY: 0.05 }, aspect), aspect)!;
    expect(f.h).toBeCloseTo(0.65, 5);
    expect(f.v).toBeCloseTo(0.05, 5);
    expect(f.left.h).toBeCloseTo(0.65, 5);
    expect(f.right.h).toBeCloseTo(0.65, 5);
  });
  it("openness drops when the lids close", () => {
    const open = extractFeatures(syntheticFace({ openness: 0.32 }, aspect), aspect)!;
    const shut = extractFeatures(syntheticFace({ openness: 0.04 }, aspect), aspect)!;
    expect(open.openness).toBeCloseTo(0.32, 5);
    expect(shut.openness).toBeLessThan(open.openness / 4);
  });
  it("returns null without the iris landmarks", () => {
    expect(extractFeatures(syntheticFace().slice(0, 468), aspect)).toBeNull();
    expect(extractFeatures(undefined, aspect)).toBeNull();
  });
  it("faceScale reflects distance from the camera", () => {
    const near = extractFeatures(syntheticFace({ eyeWidth: 0.09 }, aspect), aspect)!;
    const far = extractFeatures(syntheticFace({ eyeWidth: 0.03 }, aspect), aspect)!;
    expect(near.faceScale).toBeGreaterThan(far.faceScale * 2);
  });
});

describe("head pose", () => {
  it("identity matrix is facing forward", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1];
    const pose = headPoseFromMatrix(identity)!;
    expect(Math.abs(pose.yaw)).toBeLessThan(1e-9);
    expect(Math.abs(pose.pitch)).toBeLessThan(1e-9);
    expect(Math.abs(pose.roll)).toBeLessThan(1e-9);
  });
  it("rotation about the vertical axis is reported as yaw", () => {
    const a = (20 * Math.PI) / 180;
    // Column-major rotation about Y.
    const m = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
    expect(headPoseFromMatrix(m)!.yaw).toBeCloseTo(20, 6);
  });
});

describe("blendshapes", () => {
  it("averages both eyes", () => {
    expect(
      blinkFromBlendshapes([
        { categoryName: "eyeBlinkLeft", score: 0.8 },
        { categoryName: "eyeBlinkRight", score: 0.6 },
      ]),
    ).toBeCloseTo(0.7);
    expect(blinkFromBlendshapes([])).toBeNull();
  });
});
