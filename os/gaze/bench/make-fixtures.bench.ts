/**
 * Generates the replay fixtures in fixtures/replay/ from the synthetic face (no person involved):
 *
 *   calibration-natural.json  a full calibration + validation session (labels mark each dot)
 *   help-signal.json        looking at the screen, then three long blinks (Lifeline's signal)
 *   reading-blinks.json     reading a page with natural blinks and a 3 s rest with eyes closed
 *
 * Landmarks only (the pipeline's indices), like a real opt-in recording.
 *   cd os/gaze && npm run fixtures
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { GazeEngine } from "../src/engine";
import { singleDisplay } from "../src/screen";
import { Recorder, type Recording } from "../src/record";
import { MACBOOK_DISPLAY, SyntheticFace, TYPICAL_NOISE, WEBCAM_640, randomAnatomy } from "../src/synth/face";
import { GazeScript, HeadMotion, readingFixations, simulate, type SimFrame } from "../src/synth/scenarios";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures", "replay");
const DISPLAY = { x: 0, y: 0, width: MACBOOK_DISPLAY.widthPt, height: MACBOOK_DISPLAY.heightPt };

function face(seed: number) {
  return new SyntheticFace(randomAnatomy(seed), MACBOOK_DISPLAY, WEBCAM_640, TYPICAL_NOISE, seed);
}

function add(rec: Recorder, f: SimFrame) {
  rec.add({
    t: f.t,
    landmarks: f.frame.landmarks,
    matrix: f.frame.matrix,
    blink: f.frame.blinkScore,
    aspect: f.frame.aspect,
  });
}

function save(name: string, r: Recording) {
  mkdirSync(out, { recursive: true });
  // Four decimals of image width is 0.06 px at 640 px: plenty, and keeps fixtures small.
  const json = JSON.stringify(r, (_k, v: unknown) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v));
  writeFileSync(join(out, name), json);
  console.log(name, r.frames.length, "frames", Math.round(json.length / 1024), "KB");
}

it("make replay fixtures", () => {
  // 1. Calibration through the engine's own CalibrationRun (labels per dot), so replaying the
  //    recording through the engine makes exactly the same decisions.
  {
    const f = face(21);
    const head = new HeadMotion({ kind: "natural", seed: 21 });
    const engine = new GazeEngine({ screen: singleDisplay(DISPLAY.width, DISPLAY.height) });
    const run = engine.startCalibration({ display: DISPLAY });
    const rec = new Recorder(true, {
      origin: "synthetic",
      note: "calibration, natural head movement, seed 21",
    });
    let t = 0;
    let prev = { x: DISPLAY.width / 2, y: DISPLAY.height / 2 };
    for (let i = 0; i < 40; i++) {
      const step = run.next();
      if (step.kind !== "target") break;
      const g = step.target;
      const script = new GazeScript(
        [
          { x: prev.x, y: prev.y, durationMs: 1 },
          { x: g.x, y: g.y, durationMs: 1900 },
        ],
        { seed: i },
      );
      void run.collect(g.id, { settleMs: 800, collectMs: 1000 });
      for (const s of simulate(f, script, head, { startMs: t, seed: i })) {
        add(rec, s);
        engine.handle({
          kind: "face",
          frame: {
            t: s.t,
            landmarks: s.frame.landmarks,
            matrix: s.frame.matrix,
            blink: s.frame.blinkScore,
            aspect: s.frame.aspect,
          },
        });
      }
      rec.label({
        t0: t,
        t1: t + 1900,
        x: g.x,
        y: g.y,
        kind: g.phase === "train" ? "calibration" : "validation",
      });
      t += 1900 + 34;
      prev = g;
    }
    save("calibration-natural.json", rec.finish(DISPLAY));
  }
  // 2. Help signal: 2 s looking, three ~1 s closures 0.8 s apart, then 3 s looking.
  {
    const rec = new Recorder(true, { origin: "synthetic", note: "three long blinks (help signal), seed 22" });
    const script = new GazeScript([{ x: 700, y: 450, durationMs: 9000 }], {
      naturalBlinks: false,
      closures: [
        [2000, 1000],
        [3800, 1100],
        [5700, 950],
      ],
      seed: 22,
    });
    for (const s of simulate(face(22), script, new HeadMotion({ kind: "still", seed: 22 }))) add(rec, s);
    rec.label({ t0: 2000, t1: 6650, x: 700, y: 450, kind: "blink-pattern" });
    save("help-signal.json", rec.finish(DISPLAY));
  }
  // 3. Reading with natural blinks and a rest with the eyes closed for 3 s (must not signal).
  {
    const rec = new Recorder(true, {
      origin: "synthetic",
      note: "reading, natural blinks, 3 s rest, seed 23",
    });
    const fix = readingFixations(DISPLAY, { seed: 23, lines: 8 });
    const script = new GazeScript(fix, { seed: 23, closures: [[9000, 3000]] });
    for (const s of simulate(face(23), script, new HeadMotion({ kind: "natural", seed: 23 }), { fps: 30 }))
      add(rec, s);
    rec.label({ t0: 0, t1: script.totalMs, x: 0, y: 0, kind: "reading" });
    save("reading-blinks.json", rec.finish(DISPLAY));
  }
});
