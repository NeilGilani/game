import { describe, expect, it } from "vitest";
import { GazeStabilizer } from "../src/vision/stabilizer";

/** Deterministic noise in [-a, a]. */
function noise(seed: number, a: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * a;
}

describe("gaze stabilizer", () => {
  it("holds still while the eyes rest, despite webcam wobble", () => {
    const s = new GazeStabilizer({ radius: 60 });
    s.update({ x: 500, y: 400 });
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < 90; i++) out.push(s.update({ x: 500 + noise(i, 45), y: 400 + noise(i + 99, 45) }));
    // Raw input wobbles up to 45 px each way; the pointer barely moves between frames.
    const steps = out.slice(1).map((p, i) => Math.hypot(p.x - out[i]!.x, p.y - out[i]!.y));
    expect(Math.max(...steps)).toBeLessThan(4);
    const last = out.at(-1)!;
    expect(Math.hypot(last.x - 500, last.y - 400)).toBeLessThan(20);
  });

  it("moves quickly to a new place when the eyes really move", () => {
    const s = new GazeStabilizer({ radius: 60 });
    s.update({ x: 200, y: 200 });
    let p = { x: 200, y: 200 };
    let frames = 0;
    while (Math.hypot(p.x - 900, p.y - 600) > 30 && frames < 30) {
      p = s.update({ x: 900, y: 600 });
      frames += 1;
    }
    expect(frames).toBeLessThanOrEqual(8); // about a quarter of a second at 30 fps
  });

  it("ignores a single wild frame", () => {
    const s = new GazeStabilizer({ radius: 60 });
    s.update({ x: 300, y: 300 });
    s.update({ x: 300, y: 300 });
    const after = s.update({ x: 1200, y: 50 }); // glitch
    expect(after).toEqual({ x: 300, y: 300 });
    const back = s.update({ x: 302, y: 301 });
    expect(Math.hypot(back.x - 300, back.y - 300)).toBeLessThan(2);
  });

  it("drifts onto a slightly-off fixation without jumping", () => {
    const s = new GazeStabilizer({ radius: 60 });
    s.update({ x: 400, y: 400 });
    let p = { x: 400, y: 400 };
    for (let i = 0; i < 60; i++) p = s.update({ x: 440, y: 400 });
    expect(p.x).toBeGreaterThan(435);
  });
});
