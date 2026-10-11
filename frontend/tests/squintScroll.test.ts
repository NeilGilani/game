import { describe, expect, it } from "vitest";
import { SquintGesture } from "../src/input/squintGesture";

describe("squint to scroll", () => {
  it("starts only after a held squint, not a quick blink-like flicker", () => {
    const g = new SquintGesture();
    expect(g.update(0, 0.7, 400)).toBeNull();
    expect(g.update(100, 0.1, 400)).toBeNull(); // let go too soon
    expect(g.update(200, 0.7, 400)).toBeNull();
    expect(g.update(500, 0.7, 400)).toBe("start");
    expect(g.active).toBe(true);
  });

  it("scrolls the way the head moves, faster the further it moves, nothing near the start", () => {
    const g = new SquintGesture();
    g.update(0, 0.7, 400);
    g.update(300, 0.7, 400);
    expect(g.speed(410)).toBe(0);
    expect(g.speed(500)).toBeGreaterThan(0);
    expect(g.speed(600)).toBeGreaterThan(g.speed(500));
    expect(g.speed(300)).toBeLessThan(0);
  });

  it("stops when the eyes open", () => {
    const g = new SquintGesture();
    g.update(0, 0.7, 400);
    g.update(300, 0.7, 400);
    expect(g.update(400, 0.35, 450)).toBeNull(); // still squinting enough
    expect(g.update(500, 0.1, 450)).toBe("stop");
    expect(g.active).toBe(false);
  });
});
