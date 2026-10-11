import { describe, expect, it } from "vitest";
import { GazeCursor } from "../src/cursor";
import { FixationSmoother } from "../src/fixation";
import { gaussian, rng } from "../src/linalg";

const FRAME = 33;
const MIN_JUMP = 50;

/** A camera feed into the cursor through a real fixation smoother. */
function rig(noise = 40, seed = 3) {
  const rand = rng(seed);
  const smoother = new FixationSmoother({ initialNoisePt: noise });
  const cursor = new GazeCursor();
  let t = 0;
  const frame = (x: number, y: number, extra: { blink?: number; tracking?: number; sd?: number } = {}) => {
    t += FRAME;
    const sd = extra.sd ?? noise / Math.SQRT2;
    const raw = { x: x + gaussian(rand) * sd, y: y + gaussian(rand) * sd };
    const smoothed = smoother.update(t, raw.x, raw.y);
    cursor.gaze({
      t,
      raw,
      smoothed,
      tracking: extra.tracking ?? 1,
      blink: extra.blink ?? 0.02,
      minJumpPt: MIN_JUMP,
    });
  };
  return { cursor, frame, now: () => t };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("gaze cursor", () => {
  it("is much steadier than the raw samples while fixating, and steadier the longer the look", () => {
    const { cursor, frame, now } = rig(140);
    const early: { x: number; y: number }[] = [];
    const late: { x: number; y: number }[] = [];
    for (let i = 0; i < 90; i++) {
      frame(700, 400);
      // Draw at 60 Hz: twice per camera frame.
      for (const dt of [0, 16]) {
        const p = cursor.at(now() + dt)!;
        if (i >= 10 && i < 30) early.push(p);
        if (i >= 60) late.push(p);
      }
    }
    const rms = (v: { x: number; y: number }[]) => {
      const m = {
        x: v.reduce((a, p) => a + p.x, 0) / v.length,
        y: v.reduce((a, p) => a + p.y, 0) / v.length,
      };
      return Math.sqrt(v.reduce((a, p) => a + dist(p, m) ** 2, 0) / v.length);
    };
    expect(rms(late)).toBeLessThan(25); // raw is about 140
    expect(rms(late)).toBeLessThan(rms(early));
  });

  it("glides to a new place after a saccade in 120 to 180 ms, eased, without snapping", () => {
    const { cursor, frame, now } = rig(40);
    for (let i = 0; i < 40; i++) frame(300, 300);
    const start = cursor.at(now())!;
    frame(1100, 600); // one frame isn't a saccade
    expect(dist(cursor.at(now())!, start)).toBeLessThan(20);
    frame(1100, 600); // the second frame confirms it
    const t0 = now();
    const path = [0, 16, 33, 50, 66, 83, 100, 116, 133, 150, 166, 183].map((dt) => cursor.at(t0 + dt)!);
    const total = dist(start, { x: 1100, y: 600 });
    // No snap: the first drawn frame after detection hasn't jumped there.
    expect(dist(path[1]!, start)).toBeLessThan(total * 0.5);
    // Keeps moving every display frame (no 30 fps steps), and the steps shrink as it lands.
    const steps = path.slice(1).map((p, i) => dist(p, path[i]!));
    expect(steps.slice(0, 8).every((s) => s > 1)).toBe(true);
    expect(steps[6]!).toBeLessThan(steps[1]!);
    // Arrives within 120 to 180 ms (close to where the frames say, give or take the noise).
    expect(dist(cursor.at(t0 + 180)!, { x: 1100, y: 600 })).toBeLessThan(60);
    expect(dist(cursor.at(t0 + 100)!, { x: 1100, y: 600 })).toBeGreaterThan(20);
  });

  it("ignores drift and microsaccades under a degree", () => {
    const { cursor, frame, now } = rig(30);
    for (let i = 0; i < 40; i++) frame(600, 500);
    const before = cursor.at(now())!;
    // Wander by up to 30 points (well under a degree) for two seconds.
    for (let i = 0; i < 60; i++) frame(600 + 30 * Math.sin(i / 7), 500 + 20 * Math.cos(i / 5));
    expect(dist(cursor.at(now())!, before)).toBeLessThan(30);
  });

  it("never moves on blink frames or low-confidence frames, and resumes without a jump", () => {
    const { cursor, frame, now } = rig(40);
    for (let i = 0; i < 40; i++) frame(800, 400);
    // Closing eyes: wild, low samples; then a lost face (low tracking).
    frame(800, 900, { blink: 0.9, sd: 200 });
    const held = cursor.at(now())!;
    for (let i = 0; i < 4; i++) frame(800, 900, { blink: 0.9, sd: 200 });
    for (let i = 0; i < 4; i++) frame(100, 100, { tracking: 0.2 });
    for (let dt = 0; dt < 200; dt += 16) expect(cursor.at(now() + dt)).toEqual(held);
    // Eyes open again on the same place: the cursor carries on from where it was held.
    frame(800, 400);
    expect(cursor.at(now())).toEqual(held);
    for (let i = 0; i < 10; i++) frame(800, 400);
    expect(dist(cursor.at(now())!, held)).toBeLessThan(25);
  });

  it("a single wild frame doesn't move it", () => {
    const { cursor, frame, now } = rig(40);
    for (let i = 0; i < 40; i++) frame(500, 500);
    const before = cursor.at(now())!;
    frame(1400, 50, { sd: 0 });
    frame(500, 500);
    expect(dist(cursor.at(now())!, before)).toBeLessThan(25);
  });

  it("catches a jump the smoother's thresholds miss at webcam noise, within half a second", () => {
    const { cursor, frame, now } = rig(320, 11);
    for (let i = 0; i < 60; i++) frame(400, 500);
    let moved = -1;
    for (let i = 0; i < 30; i++) {
      frame(800, 500); // about 8 degrees, under 2 sigma of one sample
      if (moved < 0 && cursor.at(now() + 200)!.x > 650) moved = i;
    }
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(moved).toBeLessThanOrEqual(15);
  });

  it("is null until the first sample, and after reset", () => {
    const { cursor, frame, now } = rig();
    expect(cursor.at(0)).toBeNull();
    frame(10, 10);
    expect(cursor.at(now())).not.toBeNull();
    cursor.reset();
    expect(cursor.at(now())).toBeNull();
  });

  it("follows a head pointer between camera frames", () => {
    const cursor = new GazeCursor();
    cursor.follow(0, { x: 0, y: 0 });
    cursor.follow(33, { x: 100, y: 0 });
    const xs = [33, 41, 49, 57, 66].map((t) => cursor.at(t)!.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect(xs.at(-1)!).toBeLessThan(100);
  });
});
