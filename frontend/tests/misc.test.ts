import { describe, expect, it } from "vitest";
import { findTarget } from "../src/input/targets";
import { BlinkSwitch } from "../src/vision/blink";
import { CAMERA_ERRORS, classifyCameraError } from "../src/vision/camera";
import { extractFeatures } from "../src/vision/landmarks";
import { PointFilter } from "../src/vision/oneEuro";
import { assessBrightness, assessFace, meanLuminance, trackingConfidence } from "../src/vision/quality";
import { syntheticFace } from "./fixtures";

const env = { secure: true, hasMediaDevices: true };

describe("camera failures are classified for the person", () => {
  it.each([
    ["NotSupportedError", "unsupported"],
    ["NotAllowedError", "permission-denied"],
    ["NotFoundError", "no-camera"],
    ["OverconstrainedError", "no-camera"],
    ["NotReadableError", "camera-busy"],
    ["ModelLoadError", "model-failed"],
    ["WeirdError", "unknown"],
  ])("%s -> %s", (name, kind) => {
    expect(classifyCameraError({ name }, env)).toBe(kind);
  });
  it("detects an insecure page and an unsupported browser first", () => {
    expect(classifyCameraError({ name: "NotAllowedError" }, { secure: false, hasMediaDevices: true })).toBe(
      "insecure-context",
    );
    expect(classifyCameraError(new Error("x"), { secure: true, hasMediaDevices: false })).toBe("unsupported");
  });
  it("every error has guidance", () => {
    for (const info of Object.values(CAMERA_ERRORS)) expect(info.body.length).toBeGreaterThan(20);
  });
});

describe("target hit-testing", () => {
  const targets = [
    { id: "approve", rect: { left: 0, top: 0, right: 300, bottom: 100 } },
    { id: "reject", rect: { left: 400, top: 0, right: 700, bottom: 100 } },
  ];
  it("finds the containing target", () => expect(findTarget(150, 50, targets, 40)).toBe("approve"));
  it("snaps to a nearby target", () => expect(findTarget(320, 50, targets, 40)).toBe("approve"));
  it("does not snap across a wide gap", () => expect(findTarget(350, 50, targets, 40)).toBeNull());
});

describe("long-blink switch", () => {
  it("ignores ordinary blinks and fires once for a held blink", () => {
    const b = new BlinkSwitch({ holdMs: 450 });
    let fired = 0;
    for (let t = 0; t < 200; t += 33) fired += b.update(t, 0.9).fired ? 1 : 0; // 200 ms blink
    for (let t = 200; t < 600; t += 33) fired += b.update(t, 0.05).fired ? 1 : 0;
    expect(fired).toBe(0);
    for (let t = 600; t < 1600; t += 33) fired += b.update(t, 0.9).fired ? 1 : 0; // 1 s hold
    expect(fired).toBe(1);
  });
  it("never treats a lost face as a blink", () => {
    const b = new BlinkSwitch({ holdMs: 300 });
    let fired = 0;
    for (let t = 0; t < 2000; t += 33) fired += b.update(t, null).fired ? 1 : 0;
    expect(fired).toBe(0);
  });
});

describe("tracking quality", () => {
  const aspect = 4 / 3;
  it("flags a missing face and distance problems", () => {
    expect(assessFace(null)).toEqual(["no-face"]);
    expect(assessFace(extractFeatures(syntheticFace({ eyeWidth: 0.02 }, aspect), aspect))).toContain(
      "too-far",
    );
    expect(assessFace(extractFeatures(syntheticFace({}, aspect), aspect))).toEqual([]);
  });
  it("low confidence during a blink", () => {
    const f = extractFeatures(syntheticFace({}, aspect), aspect);
    expect(trackingConfidence(f, 0.0)).toBeGreaterThan(0.9);
    expect(trackingConfidence(f, 0.9)).toBeLessThan(0.2);
    expect(trackingConfidence(null, null)).toBe(0);
  });
  it("brightness", () => {
    const dark = new Uint8ClampedArray(400).fill(10);
    expect(assessBrightness(meanLuminance(dark))).toBe("too-dark");
    expect(assessBrightness(128)).toBeNull();
  });
});

describe("pointer smoothing", () => {
  it("reduces jitter around a fixed point", () => {
    const f = new PointFilter({ minCutoff: 1, beta: 0.001, dCutoff: 1 });
    let maxDev = 0;
    for (let i = 0; i < 120; i++) {
      const p = f.filter(500 + (i % 2 ? 20 : -20), 300, i * 33);
      if (i > 30) maxDev = Math.max(maxDev, Math.abs(p.x - 500));
    }
    expect(maxDev).toBeLessThan(10);
  });
});
