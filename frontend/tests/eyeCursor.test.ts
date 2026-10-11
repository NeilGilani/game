import { describe, expect, it } from "vitest";
import { EyeCursor } from "../src/vision/eyeCursor";

/** Both irises at (x, y) in the camera picture (0..1). */
function eyes(x: number, y: number) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  lm[468] = { x: x - 0.03, y };
  lm[473] = { x: x + 0.03, y };
  return lm;
}

function settle(c: EyeCursor, x = 0.5, y = 0.5, t0 = 0) {
  let t = t0;
  for (let i = 0; i < 15; i++) c.update(eyes(x, y), (t += 33), 0);
  return t;
}

function hold(c: EyeCursor, x: number, y: number, t: number, blink = 0, frames = 30) {
  let at = null;
  for (let i = 0; i < frames; i++) at = c.update(eyes(x, y), (t += 33), blink);
  return { at: at!, t };
}

describe("EyeCursor (iris eye cursor)", () => {
  it("starts in the middle, wherever the person is", () => {
    const c = new EyeCursor();
    const t = settle(c, 0.62, 0.4);
    const { at } = hold(c, 0.62, 0.4, t);
    expect(at.x).toBeCloseTo(0.5, 3);
    expect(at.y).toBeCloseTo(0.5, 3);
  });

  it("reaches the edges and the bottom of the screen", () => {
    const c = new EyeCursor();
    const t = settle(c);
    expect(hold(c, 0.25, 0.5, t).at.x).toBeGreaterThan(0.98); // mirrored: the picture's left is the screen's right
    const c2 = new EyeCursor();
    expect(hold(c2, 0.5, 0.7, settle(c2)).at.y).toBeGreaterThan(0.98);
  });

  it("keeps moving when looking down lowers the eyelids", () => {
    const c = new EyeCursor();
    expect(hold(c, 0.5, 0.62, settle(c), 0.55).at.y).toBeGreaterThan(0.8);
  });

  it("ignores a one-frame glitch", () => {
    const c = new EyeCursor();
    const { at, t } = hold(c, 0.5, 0.5, settle(c));
    const glitch = c.update(eyes(0.5, 0.2), t + 33, 0)!; // a single frame far up
    expect(glitch.y).toBeCloseTo(at.y, 5);
    const back = c.update(eyes(0.5, 0.5), t + 66, 0)!;
    expect(back.y).toBeCloseTo(0.5, 1);
  });

  it("holds still while the eyes are closed", () => {
    const c = new EyeCursor();
    const { at, t } = hold(c, 0.5, 0.5, settle(c));
    expect(c.update(eyes(0.45, 0.6), t + 33, 0.9)).toEqual(at);
  });

  it("centres on someone new after 2 seconds without a face", () => {
    const c = new EyeCursor();
    const { t } = hold(c, 0.4, 0.5, settle(c));
    const { at } = hold(c, 0.3, 0.6, t + 2500, 0, 40);
    expect(at.x).toBeCloseTo(0.5, 3);
    expect(at.y).toBeCloseTo(0.5, 3);
  });
});
