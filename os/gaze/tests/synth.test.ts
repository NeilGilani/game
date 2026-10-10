import { describe, expect, it } from "vitest";
import { extractFeatures } from "../src/landmarks";
import { mulMat3Vec, rotationYPR } from "../src/linalg";
import {
  IRIS_DIAMETER_CM,
  MACBOOK_DISPLAY,
  NO_NOISE,
  NOMINAL_ANATOMY,
  SyntheticFace,
  WEBCAM_640,
  cameraToScreenPoint,
  screenPointToCamera,
} from "../src/synth/face";

const face = new SyntheticFace(NOMINAL_ANATOMY, MACBOOK_DISPLAY, WEBCAM_640, NO_NOISE);
const head = (yawDeg = 0, pitchDeg = 0, rollDeg = 0, x = 0, y = 12, z = 60) => ({
  position: [x, y, z] as [number, number, number],
  yawDeg,
  pitchDeg,
  rollDeg,
});

function features(gx: number, gy: number, h = head()) {
  const f = face.render({ gaze: { x: gx, y: gy }, head: h, closure: 0 });
  const out = extractFeatures(f.landmarks, f.aspect, f.matrix);
  if (!out) throw new Error("no features");
  return out;
}

describe("synthetic face", () => {
  it("maps screen points to the camera frame and back", () => {
    const p = screenPointToCamera(MACBOOK_DISPLAY, 100, 700);
    const back = cameraToScreenPoint(MACBOOK_DISPLAY, p);
    expect(back.x).toBeCloseTo(100, 6);
    expect(back.y).toBeCloseTo(700, 6);
    // Viewer's right is the camera's left.
    expect(screenPointToCamera(MACBOOK_DISPLAY, 1400, 0)[0]).toBeLessThan(0);
  });

  it("moves the iris the right way in the image when the gaze moves", () => {
    const left = features(100, 478);
    const right = features(1370, 478);
    const up = features(735, 50);
    const down = features(735, 900);
    // Looking to the viewer's right moves the iris towards image-left (raw, unmirrored image).
    expect(right.h).toBeLessThan(left.h);
    expect(down.v).toBeGreaterThan(up.v);
  });

  it("recovers the head pose that rendered the frame", () => {
    const f = features(735, 478, head(15, -8, 4));
    // headPoseFromMatrix reads MediaPipe's OpenGL frame (y up), which flips yaw and roll; its
    // Euler order also differs from the renderer's, so combined rotations differ slightly.
    expect(Math.abs(f.pose.yaw + 15)).toBeLessThan(1.5);
    expect(Math.abs(f.pose.pitch + 8)).toBeLessThan(1.5);
    expect(Math.abs(f.pose.roll + 4)).toBeLessThan(1.5);
    expect(f.translationCm![2]).toBeCloseTo(60, 3);
  });

  it("head-pose normalisation keeps eye-in-head features steady when only the head turns", () => {
    // Keep the eyes still in the head (looking straight out of the face) and turn the head: the
    // point looked at moves, raw iris-in-eye features change from projection, frontal ones don't.
    const lookStraight = (yawDeg: number, pitchDeg: number) => {
      const h = head(yawDeg, pitchDeg);
      const dir = mulMat3Vec(
        rotationYPR((yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180, 0),
        [0, 0, -1],
      );
      const s = -h.position[2] / dir[2];
      const hit: [number, number, number] = [h.position[0] + s * dir[0], h.position[1] + s * dir[1], 0];
      const p = cameraToScreenPoint(MACBOOK_DISPLAY, hit);
      return features(p.x, p.y, h);
    };
    const a = lookStraight(0, 0);
    const b = lookStraight(20, 10);
    const raw = Math.hypot(b.right.h - a.right.h, b.right.v - a.right.v);
    const norm = Math.hypot(b.rightN!.h - a.rightN!.h, b.rightN!.v - a.rightN!.v);
    expect(raw).toBeGreaterThan(0.01);
    expect(norm).toBeLessThan(raw / 3);
  });

  it("renders an iris whose size matches 11.7 mm at the head's distance", () => {
    const f = features(735, 478, head(0, 0, 0, 0, 12, 50));
    const expected = (face.fx * IRIS_DIAMETER_CM) / 50;
    expect(f.irisDiameter).toBeGreaterThan(expected * 0.9);
    expect(f.irisDiameter).toBeLessThan(expected * 1.1);
  });
});
