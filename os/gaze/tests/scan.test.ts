/**
 * Choices in the 5-second eye scan, compared on simulated people (tests/scanSim.ts): the path,
 * measuring each person's lag, and RealEye's crop augmentation. Simulated, so these compare
 * options; they are not accuracy promises.
 */

import { describe, expect, it } from "vitest";
import { CROP_FEATURES, shiftCrops } from "../src/calibration/appearance";
import { EYE_FEATURES } from "../src/eyeImage";
import { mean, simulate } from "./scanSim";

const SEEDS = [1, 2, 3, 4, 5, 6];

describe("the eye scan's path", { timeout: 60_000 }, () => {
  it("corners and diagonals beat three rows (so they stay the default)", () => {
    const corners = SEEDS.map((seed) => simulate({ seed }));
    const rows = SEEDS.map((seed) => simulate({ seed, scan: { path: "rows" } }));
    expect(corners[0]!.result.lagMs).toBeDefined();
    const c = mean(corners.map((r) => r.heldOut(r.result)));
    const w = mean(rows.map((r) => r.heldOut(r.result)));
    console.log(`scan path (landmarks, simulated): corners ${Math.round(c)} pt, rows ${Math.round(w)} pt`);
    expect(c).toBeLessThan(w);
  });

  it("both paths take about 5 seconds", async () => {
    const { PursuitCalibration } = await import("../src/calibration/pursuit");
    const display = { x: 0, y: 0, width: 1470, height: 956 };
    for (const path of ["corners", "rows"] as const) {
      const ms = new PursuitCalibration({ display, path }).durationMs;
      expect(ms).toBeGreaterThan(5000);
      expect(ms).toBeLessThan(6500);
    }
  });
});

describe("each person's lag behind the light", { timeout: 60_000 }, () => {
  it("is measured from their own scan, and beats a fixed 80 ms for slow and fast followers", () => {
    for (const lagMs of [40, 180]) {
      const measured = SEEDS.slice(0, 4).map((seed) => simulate({ seed, lagMs }));
      const fixed = SEEDS.slice(0, 4).map((seed) => simulate({ seed, lagMs, scan: { lagMs: 80 } }));
      for (const r of measured) expect(Math.abs(r.result.lagMs! - lagMs)).toBeLessThan(35);
      const m = mean(measured.map((r) => r.heldOut(r.result)));
      const f = mean(fixed.map((r) => r.heldOut(r.result)));
      console.log(
        `lag ${lagMs} ms: measured ${measured.map((r) => Math.round(r.result.lagMs!)).join(", ")} ms; ` +
          `error ${Math.round(m)} pt vs ${Math.round(f)} pt with a fixed 80 ms`,
      );
      expect(m).toBeLessThan(f);
    }
  });
});

describe("RealEye's 1 px crop augmentation", { timeout: 60_000 }, () => {
  it("moves each crop's picture like RealEye's offset crop, renormalised, leaving the landmarks alone", () => {
    expect(CROP_FEATURES).toBe(EYE_FEATURES);
    const eyes = new Float32Array(CROP_FEATURES);
    for (let i = 0; i < 30; i++) eyes[i] = i;
    // A bright pixel at row 5, column 10 of the first crop.
    eyes[30 + 5 * 40 + 10] = 1;
    const moved = shiftCrops(eyes, 1, 0);
    expect(Array.from(moved.subarray(0, 30))).toEqual(Array.from(eyes.subarray(0, 30)));
    const crop = moved.subarray(30, 830);
    const peak = crop.indexOf(Math.max(...crop));
    // The window moves right by one, so the picture moves left by one.
    expect(peak).toBe(5 * 40 + 9);
    expect(mean(Array.from(crop))).toBeCloseTo(0, 5);
    expect(mean(Array.from(crop, (v) => v * v))).toBeCloseTo(1, 4);
  });

  it("keeps the scan's fit under a second, and the error within noise of no augmentation", () => {
    const on = SEEDS.slice(0, 4).map((seed) => simulate({ seed, eyes: true }));
    const off = SEEDS.slice(0, 4).map((seed) => simulate({ seed, eyes: true, scan: { augment: false } }));
    const a = mean(on.map((r) => r.heldOut(r.result)));
    const b = mean(off.map((r) => r.heldOut(r.result)));
    const slowest = Math.max(...on.map((r) => r.fitMs));
    console.log(
      `augmentation (synthetic eye images): ${Math.round(a)} pt with, ${Math.round(b)} pt without; ` +
        `slowest fit ${Math.round(slowest)} ms`,
    );
    expect(slowest).toBeLessThan(1000);
    expect(a).toBeLessThan(b * 1.15);
  });
});
