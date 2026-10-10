import { describe, expect, it } from "vitest";
import { fakeGazeEvents, FakeGazeSource } from "../src/fakes";
import type { GazeEvent } from "../src/contracts";
import { HeadPointer } from "../src/headPointer";
import { extractFeatures } from "../src/landmarks";
import { globalToViewport, viewportToGlobal } from "../src/screen";
import { person } from "./helpers";

describe("head pointer", () => {
  it("moves towards the side the person turns their head (synthetic face)", () => {
    const hp = new HeadPointer({ x: 0, y: 0, width: 1470, height: 956 });
    const face = person(1);
    const pose = (yawDeg: number, pitchDeg: number) => {
      const f = face.render({
        gaze: { x: 735, y: 478 },
        head: { position: [0, 14, 60], yawDeg, pitchDeg, rollDeg: 0 },
        closure: 0,
      });
      return extractFeatures(f.landmarks, f.aspect, f.matrix)!.pose;
    };
    hp.update(0, pose(0, 0));
    let p = { x: 0, y: 0 };
    // In the renderer's frame, positive yaw turns the face towards the person's right: the
    // display's right as they see it.
    for (let t = 33; t < 2000; t += 33) p = hp.update(t, pose(8, 0));
    expect(p.x).toBeGreaterThan(900);
    hp.recentre();
    hp.update(3000, pose(0, 0));
    for (let t = 3033; t < 5000; t += 33) p = hp.update(t, pose(0, 6));
    expect(Math.abs(p.x - 735)).toBeLessThan(30);
  });
});

describe("fakes", () => {
  it("scripts a look, a face loss and the help pattern", () => {
    const events = fakeGazeEvents([
      { kind: "look", x: 100, y: 200, ms: 500 },
      { kind: "lose-face", ms: 300 },
      { kind: "long-blinks", count: 3 },
    ]);
    expect(events.filter((e) => e.type === "help-signal").length).toBe(1);
    expect(events.some((e) => e.type === "tracking" && e.state === "weak")).toBe(true);
    const got: GazeEvent[] = [];
    new FakeGazeSource(events).play((e) => got.push(e), Infinity);
    expect(got.length).toBe(events.length);
  });
});

describe("viewport and global points", () => {
  it("round-trips", () => {
    const w = { screenX: -1920, screenY: 40, chromeTop: 80, chromeLeft: 0, zoom: 1.25 };
    const g = viewportToGlobal(w, 100, 50);
    expect(g).toEqual({ x: -1795, y: 182.5 });
    expect(globalToViewport(w, g.x, g.y)).toEqual({ x: 100, y: 50 });
  });
});
