/**
 * Drift after the scan, and the 2-second touch-up, with simulated people (synth/). A drift here is a
 * fixed shift of the detected iris that appears after the scan: what putting on glasses, a reflection
 * or a change of lighting does to real landmarks. All numbers are simulated.
 */
import { describe, expect, it } from "vitest";
import { TouchUp } from "../src/calibration/touchup";
import type { EngineAdvice, GazeEngine } from "../src/engine";
import { type SyntheticFace, TYPICAL_NOISE } from "../src/synth/face";
import type { HeadSource } from "../src/synth/scenarios";
import { DISPLAY, GRID, faceFrame, fixate, gridError, person, scannedEngine } from "./helpers";
import { GazeScript, simulate } from "../src/synth/scenarios";

const SPOTS = [
  [0.15, 0.2],
  [0.5, 0.2],
  [0.85, 0.2],
  [0.15, 0.5],
  [0.85, 0.5],
  [0.3, 0.8],
  [0.7, 0.8],
  [0.5, 0.5],
] as const;

/** Selections on 100 pt targets (the person got there, by the picker if need be); returns the end time. */
function use(engine: GazeEngine, face: SyntheticFace, head: HeadSource, t: number, rounds = 1): number {
  let n = 0;
  for (let r = 0; r < rounds; r++)
    for (const [nx, ny] of SPOTS) {
      const target = { x: DISPLAY.width * nx, y: DISPLAY.height * ny };
      const start = t;
      fixate(engine, face, head, target, t, 1500);
      t += 1500;
      engine.selection(
        `u${t}-${n++}`,
        { x: target.x - 50, y: target.y - 50, width: 100, height: 100 },
        t,
        start,
      );
      t += 300;
    }
  return t;
}

/** The person looks at the touch-up dot until it's done (or closes their eyes through it). */
async function lookAtDot(
  engine: GazeEngine,
  face: SyntheticFace,
  head: HeadSource,
  t: number,
  closed = false,
) {
  const { target, done } = engine.startTouchUp();
  const script = new GazeScript([{ ...target, durationMs: 2300 }], {
    naturalBlinks: false,
    closures: closed ? [[0, 2300]] : [],
  });
  for (const f of simulate(face, script, head, { startMs: t })) engine.handle(faceFrame(f));
  return { result: await done, end: t + 2400 };
}

function glasses(seed: number, px: [number, number]) {
  return person(seed, { ...TYPICAL_NOISE, irisBiasPx: px });
}

describe("drift after the scan (simulated)", () => {
  it(
    "a large drift in one direction asks for a 2-second touch-up, which fixes it",
    { timeout: 120_000 },
    async () => {
      const sums = { before: 0, drifted: 0, fixed: 0 };
      const seeds = [1, 2, 3, 4];
      for (const seed of seeds) {
        const { engine, face, head, endMs } = scannedEngine(seed, "natural");
        const advice: EngineAdvice[] = [];
        engine.onAdvice((a) => advice.push(a));
        let t = endMs + 1000;
        sums.before += gridError(engine, face, head, t);
        t += GRID.length * 1600 + 1000;
        // Glasses on: the iris now reads 1.2 px off in the camera image, on every frame.
        const worn = glasses(seed, [1.2, 0.8]);
        sums.drifted += gridError(engine, worn, head, t);
        t += GRID.length * 1600 + 1000;
        t = use(engine, worn, head, t);
        fixate(engine, worn, head, { x: 735, y: 478 }, t, 5000);
        t += 5000;
        const asked = advice.filter((a) => a.type === "touch-up");
        expect(asked.length, `seed ${seed}`).toBe(1);
        expect(advice.some((a) => a.type === "recalibrate")).toBe(false);
        const { result, end } = await lookAtDot(engine, worn, head, t);
        expect(result.kind).toBe("done");
        expect(advice.find((a) => a.type === "touch-up-result")).toMatchObject({ applied: true });
        sums.fixed += gridError(engine, worn, head, end);
      }
      const k = seeds.length;
      console.log(
        `glasses on after the scan (simulated): ${Math.round(sums.before / k)} pt before, ` +
          `${Math.round(sums.drifted / k)} pt with the drift, ${Math.round(sums.fixed / k)} pt after a 2-second touch-up`,
      );
      expect(sums.drifted).toBeGreaterThan(1.5 * sums.before);
      expect(sums.fixed).toBeLessThan(0.6 * sums.drifted);
      expect(sums.fixed / k).toBeLessThan(sums.before / k + 25);
    },
  );

  it("a small drift is corrected quietly, without asking for anything", { timeout: 120_000 }, () => {
    const { engine, head, endMs } = scannedEngine(2, "natural");
    const advice: EngineAdvice[] = [];
    engine.onAdvice((a) => advice.push(a));
    const worn = glasses(2, [0.2, 0.15]);
    let t = endMs + 1000;
    const drifted = gridError(engine, worn, head, t);
    t += GRID.length * 1600 + 1000;
    t = use(engine, worn, head, t, 3);
    fixate(engine, worn, head, { x: 735, y: 478 }, t, 5000);
    t += 5000;
    const after = gridError(engine, worn, head, t);
    console.log(
      `small drift (simulated): ${Math.round(drifted)} pt -> ${Math.round(after)} pt, corrected quietly`,
    );
    expect(advice.some((a) => a.type === "touch-up" || a.type === "recalibrate")).toBe(false);
    expect(advice.some((a) => a.type === "continuous" && a.event.type === "updated")).toBe(true);
    expect(after).toBeLessThan(drifted);
  });

  it("a touch-up with the eyes closed changes nothing", { timeout: 60_000 }, async () => {
    const { engine, face, head, endMs } = scannedEngine(1, "still");
    const before = engine.last;
    const { result } = await lookAtDot(engine, face, head, endMs + 1000, true);
    expect(result.kind).toBe("failed");
    expect(before).not.toBe(engine.last);
    const advice: EngineAdvice[] = [];
    engine.onAdvice((a) => advice.push(a));
    const again = await lookAtDot(engine, face, head, endMs + 5000);
    expect(again.result.kind).toBe("done");
    // Without a drift, a touch-up barely moves anything.
    const moved = advice.find((a) => a.type === "continuous" && a.event.type === "touched-up");
    expect(
      moved && moved.type === "continuous" && moved.event.type === "touched-up" && moved.event.shiftPt,
    ).toBeLessThan(60);
  });
});

describe("TouchUp", () => {
  it("waits for the eyes to land, then takes the median", () => {
    const tu = new TouchUp({ target: { x: 100, y: 100 } });
    for (let ms = 0; ms <= 2000; ms += 33) {
      const landed = ms >= 500;
      tu.add(ms, landed ? { x: 160 + (ms % 7), y: 90 } : { x: 900, y: 900 }, [1, 0, 0, 0, 0], 1, 0);
    }
    const r = tu.finish();
    expect(r.kind).toBe("done");
    if (r.kind !== "done") return;
    expect(r.estimate.x).toBeGreaterThan(159);
    expect(r.estimate.x).toBeLessThan(167);
    expect(r.z[0]).toBe(1);
  });

  it("fails when the eyes wander or aren't seen", () => {
    const wander = new TouchUp({ target: { x: 100, y: 100 } });
    for (let ms = 0; ms <= 2000; ms += 33)
      wander.add(ms, { x: (ms * 7) % 1400, y: (ms * 3) % 900 }, null, 1, 0);
    expect(wander.finish().kind).toBe("failed");
    const blinks = new TouchUp({ target: { x: 100, y: 100 } });
    for (let ms = 0; ms <= 2000; ms += 33) blinks.add(ms, { x: 100, y: 100 }, null, 0.2, 0.9);
    expect(blinks.finish().kind).toBe("failed");
  });
});
