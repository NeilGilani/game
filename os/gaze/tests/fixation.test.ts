import { describe, expect, it } from "vitest";
import { FixationSmoother, ivtLabels } from "../src/fixation";
import { OneEuroFilter } from "../src/oneEuro";
import { gaussian, rng } from "../src/linalg";

const rand = rng(5);
const noisy = (x: number, sd: number) => x + gaussian(rand) * sd;

describe("fixation smoother", () => {
  it("is far steadier than the raw signal during a fixation", () => {
    const s = new FixationSmoother({ initialNoisePt: 140 });
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < 90; i++) {
      const p = s.update(i * 33, noisy(700, 100), noisy(400, 100));
      if (i > 15) out.push(p);
    }
    const rms = Math.sqrt(out.reduce((a, p) => a + (p.x - 700) ** 2 + (p.y - 400) ** 2, 0) / out.length);
    expect(rms).toBeLessThan(50); // raw is about 141 (100 per axis)
    expect(s.current!.fixation).toBe(true);
    expect(s.noisePt).toBeGreaterThan(100);
    expect(s.noisePt).toBeLessThan(190);
  });

  it("jumps on the second frame of a big saccade instead of sliding", () => {
    const s = new FixationSmoother({ initialNoisePt: 60 });
    for (let i = 0; i < 30; i++) s.update(i * 33, noisy(200, 40), noisy(300, 40));
    const first = s.update(30 * 33, 1200, 700);
    expect(first.saccade).toBe(false);
    const p = s.update(31 * 33, 1200, 700);
    expect(p.saccade).toBe(true);
    expect(Math.hypot(p.x - 1200, p.y - 700)).toBeLessThan(1);
  });

  it("ignores a single wild frame (glare, a half blink)", () => {
    const s = new FixationSmoother({ initialNoisePt: 60 });
    for (let i = 0; i < 30; i++) s.update(i * 33, noisy(700, 40), noisy(400, 40));
    const spike = s.update(30 * 33, 1400, 50);
    expect(spike.saccade).toBe(false);
    expect(Math.hypot(spike.x - 700, spike.y - 400)).toBeLessThan(60);
    const after = s.update(31 * 33, noisy(700, 40), noisy(400, 40));
    expect(after.saccade).toBe(false);
    expect(Math.hypot(after.x - 700, after.y - 400)).toBeLessThan(60);
  });

  it("catches a smaller saccade within a few frames", () => {
    const s = new FixationSmoother({ initialNoisePt: 60 });
    for (let i = 0; i < 30; i++) s.update(i * 33, noisy(500, 40), noisy(400, 40));
    let frames = 0;
    for (let i = 30; i < 45; i++) {
      frames += 1;
      if (s.update(i * 33, noisy(700, 40), noisy(400, 40)).saccade) break;
    }
    expect(frames).toBeLessThanOrEqual(6);
    for (let i = 45; i < 60; i++) s.update(i * 33, noisy(700, 40), noisy(400, 40));
    expect(Math.abs(s.current!.x - 700)).toBeLessThan(40);
  });

  it("rarely mistakes noise for a saccade", () => {
    const s = new FixationSmoother({ initialNoisePt: 140 });
    let saccades = 0;
    const frames = 30 * 60 * 3; // three minutes at 30 Hz
    for (let i = 0; i < frames; i++)
      if (s.update(i * 33, noisy(700, 100), noisy(400, 100)).saccade) saccades++;
    expect(saccades / 3).toBeLessThan(3); // per minute
  });

  it("is steadier than the web app's One Euro settings without being slower to arrive", () => {
    const s = new FixationSmoother({ initialNoisePt: 140 });
    const f = new OneEuroFilter({ minCutoff: 0.6, beta: 0.004, dCutoff: 1 });
    let t = 0;
    const sErr: number[] = [];
    const fErr: number[] = [];
    for (let i = 0; i < 60; i++, t += 33) {
      const x = noisy(300, 100);
      const sp = s.update(t, x, 0).x;
      const fp = f.filter(x, t);
      if (i > 20) {
        sErr.push((sp - 300) ** 2);
        fErr.push((fp - 300) ** 2);
      }
    }
    const rms = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b, 0) / v.length);
    expect(rms(sErr)).toBeLessThan(rms(fErr) / 2);
    let arrived: number | null = null;
    for (let i = 0; i < 30; i++, t += 33) {
      if (Math.abs(s.update(t, noisy(1100, 100), 0).x - 1100) < 120) {
        arrived = i;
        break;
      }
    }
    expect(arrived).not.toBeNull();
    expect(arrived!).toBeLessThanOrEqual(3);
  });

  it("I-VT labels a jump as a saccade", () => {
    const labels = ivtLabels(
      [
        { t: 0, x: 0, y: 0 },
        { t: 33, x: 2, y: 0 },
        { t: 66, x: 600, y: 0 },
      ],
      3000,
    );
    expect(labels).toEqual([true, true, false]);
  });
});
