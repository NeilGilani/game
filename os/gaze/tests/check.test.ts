/**
 * The three check dots after the eye scan (src/calibration/check.ts), on simulated people.
 */

import { describe, expect, it } from "vitest";
import { ScanCheck } from "../src/calibration/check";
import { DISPLAY } from "./helpers";
import { mean, simulate } from "./scanSim";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe("check dots after the eye scan (simulated)", { timeout: 60_000 }, () => {
  it("show three dots in 1.5 seconds, away from the scan's path", () => {
    const { result } = simulate({ seed: 1 });
    const check = new ScanCheck(result, { display: DISPLAY });
    expect(check.durationMs).toBe(1500);
    const dots = [0, 500, 1000].map((ms) => check.at(ms + 10)!);
    expect(new Set(dots.map((d) => `${d.x},${d.y}`)).size).toBe(3);
    expect(check.at(1500)).toBeNull();
  });

  it("measure the accuracy as used closer to the truth than the scan's own estimate", () => {
    const runs = SEEDS.map((seed) => {
      const sim = simulate({ seed });
      const checked = sim.check();
      return {
        scan: sim.result.quality.meanErrorPt,
        check: checked.check!.measuredPt,
        truth: sim.heldOut(sim.result),
      };
    });
    const scanGap = mean(runs.map((r) => Math.abs(r.scan - r.truth)));
    const checkGap = mean(runs.map((r) => Math.abs(r.check - r.truth)));
    console.log(
      `check dots: true ${Math.round(mean(runs.map((r) => r.truth)))} pt; scan estimate off by ${Math.round(scanGap)} pt, ` +
        `check off by ${Math.round(checkGap)} pt`,
    );
    expect(checkGap).toBeLessThan(scanGap);
  });

  it("fix a real offset (the head moved after the scan, eye images in use), and report it held out", () => {
    const runs = SEEDS.map((seed) => {
      const sim = simulate({ seed, eyes: true, shiftCm: 1.5 });
      const checked = sim.check();
      return {
        before: sim.heldOut(checked, { offset: false }),
        after: sim.heldOut(checked),
        applied: !!checked.offset,
        reported: checked.quality.meanErrorPt,
        check: checked.check!,
      };
    });
    const before = mean(runs.map((r) => r.before));
    const after = mean(runs.map((r) => r.after));
    console.log(
      `offset fix: ${Math.round(before)} pt -> ${Math.round(after)} pt on new points ` +
        `(applied for ${runs.filter((r) => r.applied).length} of ${runs.length})`,
    );
    expect(runs.filter((r) => r.applied).length).toBeGreaterThanOrEqual(SEEDS.length / 2);
    expect(after).toBeLessThan(before * 0.8);
    for (const r of runs) {
      expect(r.reported).toBe(r.check.usedPt);
      if (r.applied) expect(r.check.usedPt).toBe(r.check.correctedPt);
      else expect(r.check.usedPt).toBe(r.check.measuredPt);
    }
  });

  it("do no real harm when there is no offset to fix", () => {
    const runs = SEEDS.map((seed) => {
      const sim = simulate({ seed });
      const checked = sim.check();
      return { without: sim.heldOut(checked, { offset: false }), with: sim.heldOut(checked) };
    });
    expect(mean(runs.map((r) => r.with))).toBeLessThan(mean(runs.map((r) => r.without)) * 1.05);
  });

  it("leave the scan's estimate in place, and say so, when the dots weren't seen", () => {
    const { result } = simulate({ seed: 2 });
    const check = new ScanCheck(result, { display: DISPLAY });
    // Eyes closed throughout: no usable frames.
    for (let ms = 0; ms < check.durationMs; ms += 33) check.add(ms, null, 0, 1);
    const out = check.finish();
    expect(out.check).toBeNull();
    expect(out.offset ?? null).toBeNull();
    expect(out.quality).toEqual(result.quality);
  });
});
