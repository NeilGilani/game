import { describe, expect, it } from "vitest";
import { NoseCursor } from "../src/vision/noseCursor";

/** A face: cheeks at cx ± w/2, nose tip at (nx, ny). Camera picture coordinates (0..1), aspect 4:3. */
function face(nx: number, ny: number, w = 0.3, cx = 0.5, cy = 0.5) {
  const lm = Array.from({ length: 478 }, () => ({ x: cx, y: cy }));
  lm[234] = { x: cx - w / 2, y: cy };
  lm[454] = { x: cx + w / 2, y: cy };
  lm[1] = { x: nx, y: ny };
  return lm;
}
const ASPECT = 4 / 3;

/** Settle on a still face, then hold a new pose for a second; returns where the cursor ends up. */
function run(
  c: NoseCursor,
  start: ReturnType<typeof face>,
  pose: ReturnType<typeof face>,
  blink = 0,
  t0 = 0,
) {
  let t = t0;
  for (let i = 0; i < 20; i++) c.update(start, ASPECT, (t += 33), 0);
  let at = c.update(pose, ASPECT, (t += 33), blink);
  for (let i = 0; i < 30; i++) at = c.update(pose, ASPECT, (t += 33), blink);
  return { at: at!, t };
}

describe("NoseCursor (the eye cursor's pointer)", () => {
  it("starts in the middle, wherever the person is", () => {
    const c = new NoseCursor();
    const { at } = run(c, face(0.62, 0.55), face(0.62, 0.55));
    expect(at.x).toBeCloseTo(0.5, 2);
    expect(at.y).toBeCloseTo(0.5, 2);
  });

  it("follows the head: right is right (mirrored camera), down is down", () => {
    const right = run(new NoseCursor(), face(0.5, 0.5), face(0.48, 0.5)).at;
    expect(right.x).toBeGreaterThan(0.6);
    const down = run(new NoseCursor(), face(0.5, 0.5), face(0.5, 0.52)).at;
    expect(down.y).toBeGreaterThan(0.6);
  });

  it("keeps moving when looking down lowers the eyelids (a partial blink score)", () => {
    const { at } = run(new NoseCursor(), face(0.5, 0.5), face(0.5, 0.53), 0.45);
    expect(at.y).toBeGreaterThan(0.75);
  });

  it("holds still through a real eye closure", () => {
    const c = new NoseCursor();
    const { at, t } = run(c, face(0.5, 0.5), face(0.5, 0.5));
    const closed = c.update(face(0.47, 0.5), ASPECT, t + 33, 0.8)!;
    expect(closed.x).toBeCloseTo(at.x, 5);
  });

  it("feels the same near or far from the camera", () => {
    const near = run(new NoseCursor(), face(0.5, 0.5, 0.4), face(0.48, 0.5, 0.4)).at;
    const far = run(new NoseCursor(), face(0.5, 0.5, 0.2), face(0.49, 0.5, 0.2)).at;
    expect(near.x).toBeCloseTo(far.x, 2);
  });

  it("centres on someone new after the face has been gone for 2 seconds", () => {
    const c = new NoseCursor();
    const { t } = run(c, face(0.5, 0.5), face(0.46, 0.5));
    let at = null;
    for (let i = 0, u = t + 2500; i < 40; i++) at = c.update(face(0.4, 0.6), ASPECT, (u += 33), 0);
    expect(at!.x).toBeCloseTo(0.5, 2);
    expect(at!.y).toBeCloseTo(0.5, 2);
  });
});
