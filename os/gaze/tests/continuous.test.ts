import { describe, expect, it } from "vitest";
import { ContinuousCalibrator, type ContinuousEvent, type Observation } from "../src/calibration/continuous";
import { gaussian, rng } from "../src/linalg";

const centre = { x: 735, y: 478 };
const rand = rng(11);

/** Observations of a fixation on a target, with the tracker off by `bias` and some noise. */
function looks(tx: number, ty: number, bias: { x: number; y: number }, noise = 15, t0 = 0): Observation[] {
  return Array.from({ length: 12 }, (_, i) => ({
    t: t0 + i * 33,
    x: tx + bias.x + gaussian(rand) * noise,
    y: ty + bias.y + gaussian(rand) * noise,
  }));
}

const rect = (cx: number, cy: number, size = 100) => ({
  x: cx - size / 2,
  y: cy - size / 2,
  width: size,
  height: size,
});

function select(
  c: ContinuousCalibrator,
  id: string,
  t: number,
  cx: number,
  cy: number,
  bias: { x: number; y: number },
) {
  return c.selected(id, t, rect(cx, cy), looks(cx, cy, bias, 15, t - 400));
}

const spots = [
  [200, 200],
  [1200, 220],
  [700, 480],
  [260, 760],
  [1250, 800],
  [700, 150],
  [420, 480],
  [1000, 600],
];

describe("continuous recalibration", () => {
  it("learns a drift from confirmed selections, in bounded steps", () => {
    const c = new ContinuousCalibrator({ centre, calibratedGrade: "good" });
    const bias = { x: 70, y: -50 }; // the head settled: estimates now land up and to the right
    let t = 0;
    const updates: ContinuousEvent[] = [];
    for (let round = 0; round < 3; round++) {
      for (const [x, y] of spots) {
        t += 1500;
        select(c, `b${t}`, t, x!, y!, bias);
        updates.push(...c.tick(t));
      }
    }
    updates.push(...c.tick(t + 10_000));
    const steps = updates.filter((e) => e.type === "updated");
    expect(steps.length).toBeGreaterThan(0);
    // Each update moves the offset at most maxStepPt (25).
    let prev = { bx: 0, by: 0 };
    for (const e of steps) {
      if (e.type !== "updated") continue;
      expect(Math.abs(e.correction.bx - prev.bx)).toBeLessThanOrEqual(25 + 1e-9);
      expect(Math.abs(e.correction.by - prev.by)).toBeLessThanOrEqual(25 + 1e-9);
      prev = e.correction;
    }
    const fixed = c.apply(700 + bias.x, 480 + bias.y);
    expect(Math.hypot(fixed.x - 700, fixed.y - 480)).toBeLessThan(30);
  });

  it("never learns from a selection that was undone", () => {
    const c = new ContinuousCalibrator({ centre, calibratedGrade: "good" });
    select(c, "a", 1000, 200, 200, { x: 200, y: 0 });
    expect(c.undone("a", 2500)).toEqual([{ type: "discarded", t: 2500, reason: "undone" }]);
    expect(c.tick(10_000).some((e) => e.type === "learned")).toBe(false);
  });

  it("ignores big targets and too-short looks", () => {
    const c = new ContinuousCalibrator({ centre, calibratedGrade: "good" });
    expect(c.selected("big", 0, rect(700, 400, 500), looks(700, 400, { x: 0, y: 0 }))[0]).toMatchObject({
      reason: "too-big",
    });
    expect(
      c.selected("short", 0, rect(700, 400), looks(700, 400, { x: 0, y: 0 }).slice(0, 3))[0],
    ).toMatchObject({
      reason: "too-few-frames",
    });
  });

  it("does not make things worse when there's nothing to fix", () => {
    const c = new ContinuousCalibrator({ centre, calibratedGrade: "good" });
    let t = 0;
    const events: ContinuousEvent[] = [];
    for (let round = 0; round < 3; round++)
      for (const [x, y] of spots) {
        t += 1500;
        select(c, `n${t}`, t, x!, y!, { x: 0, y: 0 });
        events.push(...c.tick(t));
      }
    events.push(...c.tick(t + 10_000));
    // With no bias, any proposed update must not beat the current one by enough to be applied,
    // or if applied must be tiny.
    const cur = c.current;
    expect(Math.hypot(cur.bx, cur.by)).toBeLessThan(10);
    expect(events.some((e) => e.type === "recalibrate")).toBe(false);
  });

  it("a wrong selection nobody undid doesn't drag the correction", () => {
    const c = new ContinuousCalibrator({ centre, calibratedGrade: "good" });
    let t = 0;
    for (const [x, y] of spots) {
      t += 1500;
      select(c, `w${t}`, t, x!, y!, { x: 0, y: 0 });
      c.tick(t);
    }
    // Looked at (200, 200) but a target 600 points away was selected and not undone.
    c.selected("oops", t + 100, rect(800, 700), looks(200, 200, { x: 0, y: 0 }, 15, t));
    c.tick(t + 10_000);
    expect(Math.hypot(c.current.bx, c.current.by)).toBeLessThan(15);
  });

  it("advises a clean recalibration when quality has dropped to poor", () => {
    const c = new ContinuousCalibrator({ centre, calibratedGrade: "good", maxTotalPt: 0, maxStepPt: 0 });
    let t = 0;
    const events: ContinuousEvent[] = [];
    for (const [x, y] of spots) {
      t += 1500;
      c.selected(`p${t}`, t, rect(x!, y!), looks(x!, y!, { x: 140, y: 100 }, 10, t - 400));
      events.push(...c.tick(t));
    }
    events.push(...c.tick(t + 10_000));
    const advice = events.filter((e) => e.type === "recalibrate");
    expect(advice.length).toBe(1);
    expect(c.quality.at(-1)!.grade).toBe("poor");
  });
});
