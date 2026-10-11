import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTER,
  type LabSample,
  exportMetrics,
  filterCandidates,
  measure,
  nineDots,
  recommendLock,
  replayFilter,
  tuneFilter,
} from "../src/lab";
import { rng } from "../src/linalg";

/** A person looking at each dot for 2.5 s: estimates off by `bias` px, with Gaussian noise of `sd` px per axis. */
function record(opts: { bias: number; sd: number; seed?: number; dropEvery?: number }) {
  const dots = nineDots(1440, 900);
  const r = rng(opts.seed ?? 3);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const raw: LabSample[] = [];
  let t = 0;
  let i = 0;
  for (const dot of dots) {
    const start = t;
    for (; t < start + 2500; t += 33) {
      i++;
      const lost = opts.dropEvery && i % opts.dropEvery === 0;
      const p = { x: dot.x + opts.bias + opts.sd * gauss(), y: dot.y + opts.sd * gauss() };
      raw.push({
        t,
        dot: dot.id,
        dotStart: start,
        raw: lost ? null : p,
        point: null,
        confidence: lost ? 0 : 1,
        errorRadius: 90,
      });
    }
  }
  return { dots, samples: replayFilter(raw, DEFAULT_FILTER) };
}

describe("gaze lab measurements", () => {
  it("puts nine dots at 10, 50 and 90 % of the viewport", () => {
    const d = nineDots(1000, 500);
    expect(d).toHaveLength(9);
    expect(d[0]).toEqual({ id: 0, x: 100, y: 50 });
    expect(d[4]).toEqual({ id: 4, x: 500, y: 250 });
    expect(d[8]).toEqual({ id: 8, x: 900, y: 450 });
  });

  it("measures accuracy as the offset and jitter as the shake, raw and filtered", () => {
    const { dots, samples } = record({ bias: 40, sd: 30 });
    const m = measure(samples, dots);
    expect(m.summary.dotsMeasured).toBe(9);
    expect(m.summary.accuracyPx).toBeGreaterThan(30);
    expect(m.summary.accuracyPx).toBeLessThan(50);
    expect(m.summary.rawAccuracyPx).toBeGreaterThan(30);
    expect(m.summary.rawAccuracyPx).toBeLessThan(50);
    // Raw 2D RMS of N(0, 30) per axis is about 42 px; the filter averages it down.
    expect(m.summary.rawJitterPx).toBeGreaterThan(35);
    expect(m.summary.rawJitterPx).toBeLessThan(50);
    expect(m.summary.jitterPx).toBeLessThan(m.summary.rawJitterPx / 2);
    expect(m.summary.reportedErrorRadiusPx).toBe(90);
    expect(m.summary.usable).toBe(1);
    expect(m.summary.settleMs).not.toBeNull();
  });

  it("measures the error radius the engine claims (86 % of samples inside)", () => {
    const { dots, samples } = record({ bias: 0, sd: 30 });
    const m = measure(samples, dots);
    // Filtered samples hug the dot, so the measured radius is far below 2 sigma of the raw noise (60 px).
    expect(m.summary.measuredErrorRadiusPx).toBeLessThan(60);
    const { samples: biased } = record({ bias: 80, sd: 30 });
    expect(measure(biased, dots).summary.measuredErrorRadiusPx).toBeGreaterThan(70);
  });

  it("counts lost frames as unusable and skips dots with too little data", () => {
    const { dots, samples } = record({ bias: 0, sd: 20, dropEvery: 4 });
    const m = measure(samples, dots);
    expect(m.summary.usable).toBeGreaterThan(0.7);
    expect(m.summary.usable).toBeLessThan(0.8);
    const onlyTwo = samples.filter((s) => s.dot < 2);
    expect(measure(onlyTwo, dots).summary.dotsMeasured).toBe(2);
    expect(measure([], dots).summary.dotsMeasured).toBe(0);
  });

  it("replays the person's raw estimates through other filter settings, and ranks them", () => {
    const { dots, samples } = record({ bias: 10, sd: 40 });
    const trials = tuneFilter(samples, dots);
    expect(trials).toHaveLength(filterCandidates().length);
    for (let i = 1; i < trials.length; i++)
      expect(trials[i]!.score).toBeGreaterThanOrEqual(trials[i - 1]!.score);
    // The default is among the candidates, and the best is at least as good.
    const def = trials.find(
      (t) =>
        t.settings.z === DEFAULT_FILTER.z &&
        t.settings.minK === DEFAULT_FILTER.minK &&
        t.settings.windowMs === DEFAULT_FILTER.windowMs,
    )!;
    expect(def).toBeDefined();
    expect(trials[0]!.score).toBeLessThanOrEqual(def.score);
  });

  it("recommends lock settings from measured numbers, within safe bounds", () => {
    const { dots, samples } = record({ bias: 60, sd: 30 });
    const rec = recommendLock(measure(samples, dots).summary)!;
    expect(rec.target_snap_px).toBeGreaterThanOrEqual(24);
    expect(rec.target_snap_px).toBeLessThanOrEqual(96);
    expect(rec.target_snap_px % 4).toBe(0);
    expect(rec.dwell_stability_px).toBeGreaterThanOrEqual(30);
    expect(rec.dwell_stability_px).toBeLessThanOrEqual(150);
    expect(rec.reasons).toHaveLength(2);
    const huge = recommendLock({
      ...measure(samples, dots).summary,
      measuredErrorRadiusPx: 500,
      jitterPx: 200,
    })!;
    expect(huge.target_snap_px).toBe(96);
    expect(huge.dwell_stability_px).toBe(150);
    // Too little data: no recommendation.
    expect(
      recommendLock(
        measure(
          samples.filter((s) => s.dot < 3),
          dots,
        ).summary,
      ),
    ).toBeNull();
  });

  it("exports numbers only: no samples, no positions, no time of day", () => {
    const { dots, samples } = record({ bias: 20, sd: 30 });
    const metrics = measure(samples, dots);
    const out = exportMetrics({
      date: new Date(2026, 9, 10, 19, 55, 15),
      viewport: { width: 1440.4, height: 900 },
      camera: { width: 1280, height: 720, fps: 29.7 },
      mode: "gaze",
      filter: DEFAULT_FILTER,
      metrics,
      tuning: tuneFilter(samples, dots),
    });
    const json = JSON.stringify(out);
    expect(out.date).toBe("2026-10-10");
    expect(json).not.toMatch(/"raw"|"point"|"landmarks"|"image"|"t":/);
    expect(json).not.toMatch(/"x":|"y":/);
    expect(json).not.toMatch(/T\d\d:\d\d/);
    expect(out.dots).toHaveLength(9);
    expect(out.camera).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(out.tuning?.best).toBeDefined();
    // Every number is rounded to 0.1.
    expect(String(out.summary.accuracyPx)).toMatch(/^\d+(\.\d)?$/);
  });
});
