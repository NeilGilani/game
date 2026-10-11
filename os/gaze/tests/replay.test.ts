/**
 * Replay tests: checked-in landmark recordings (fixtures/replay, generated from the synthetic face
 * by bench/make-fixtures.bench.ts, no person involved) are played through the real engine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GazeEvent } from "../src/contracts";
import { GazeEngine } from "../src/engine";
import { type Recording, isRecording } from "../src/record";
import { ReplayProvider } from "../src/providers/replay";
import type { ProviderFrame } from "../src/providers/types";
import { singleDisplay } from "../src/screen";

function load(name: string): Recording {
  const r: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "replay", name), "utf8"),
  );
  if (!isRecording(r)) throw new Error(`${name} is not a recording`);
  return r;
}

function play(name: string, engine = new GazeEngine({ screen: singleDisplay(1470, 956) })) {
  const events: GazeEvent[] = [];
  engine.on((e) => events.push(e));
  new ReplayProvider(load(name)).runSync((f) => engine.handle(f));
  return { engine, events };
}

describe("replay fixtures", () => {
  it("are synthetic, landmark-only recordings", () => {
    for (const name of ["help-signal.json", "reading-blinks.json", "calibration-natural.json"]) {
      const r = load(name);
      expect(r.origin).toBe("synthetic");
      expect(r.indices.length).toBeLessThan(30);
    }
  });

  it("help-signal.json raises Lifeline's help signal exactly once, counting 1, 2, 3", () => {
    const { events } = play("help-signal.json");
    expect(events.filter((e) => e.type === "help-signal").length).toBe(1);
    const counts = events.flatMap((e) => (e.type === "help-progress" ? [e.counted] : []));
    expect(counts.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("reading-blinks.json (natural blinks, a 3 s rest with eyes closed) never raises it", () => {
    const { events } = play("reading-blinks.json");
    expect(events.filter((e) => e.type === "help-signal").length).toBe(0);
    expect(
      events.filter((e) => e.type === "blink" && e.score !== null && e.score > 0.55).length,
    ).toBeGreaterThan(20);
  });

  it("calibration-natural.json replays to the same targets and an honest, stable quality", async () => {
    const rec = load("calibration-natural.json");
    const engine = new GazeEngine({ screen: singleDisplay(1470, 956) });
    const run = engine.startCalibration({ display: rec.display! });
    const labels = [...rec.labels];
    const replay = new ReplayProvider(rec);
    const frames: ProviderFrame[] = [];
    replay.runSync((f) => frames.push(f));
    let next = 0;
    let pending: Promise<number> | null = null;
    for (const f of frames) {
      const t = f.kind === "face" ? f.frame.t : 0;
      if (next < labels.length && t >= labels[next]!.t0) {
        const step = run.next();
        if (step.kind !== "target") throw new Error(`session ended early: ${step.kind}`);
        // The session asks for the same dots, in the same order, as when it was recorded.
        expect(step.target.x).toBeCloseTo(labels[next]!.x, 3);
        expect(step.target.y).toBeCloseTo(labels[next]!.y, 3);
        pending = run.collect(step.target.id, { settleMs: 800, collectMs: 1000 });
        next++;
      }
      engine.handle(f);
      if (pending) await Promise.race([pending, Promise.resolve()]);
    }
    const final = run.next();
    expect(final.kind).toBe("done");
    if (final.kind !== "done") return;
    const q = final.result.quality;
    expect(q.points).toBeGreaterThanOrEqual(9);
    // Regression bounds for this fixture (see BENCHMARKS.md for what the numbers mean).
    expect(q.meanErrorPt).toBeLessThan(55); // 42.3 pt since the fixture was remade with the viewing-angle fix (51.1 before)
    expect(q.meanErrorDeg).not.toBeNull();
    expect(final.result.distanceCm).toBeGreaterThan(50);
    expect(final.result.distanceCm).toBeLessThan(70);
    console.log(
      `fixture calibration: ${q.meanErrorPt.toFixed(1)} pt, ${q.meanErrorDeg?.toFixed(2)} deg, ${q.grade}`,
    );
  });
});
