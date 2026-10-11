/**
 * The drawn gaze cursor, measured: jitter while fixating, lag after a saccade, accuracy, and how far
 * it moves during blinks (definitions in cursorMetrics.ts). SIMULATED: synthetic people and camera
 * (src/synth), calibrated with the engine's own calibration, then looking around the screen with
 * fixational drift, microsaccades under 1 degree and natural blinks. The cursor is sampled at 60 Hz,
 * as a display draws it.
 *
 *   cd os/gaze && npm run bench:cursor     (writes bench/results/cursor.json and cursor.md)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";
import { GazeEngine } from "../src/engine";
import { gaussian, rng } from "../src/linalg";
import { singleDisplay } from "../src/screen";
import { type GazeTruth, GazeScript, type HeadMotionKind, simulate } from "../src/synth/scenarios";
import { DISPLAY, NOISE, lookAround, makeSubject } from "./lib";
import {
  type CursorMetrics,
  type CursorSample,
  CssTransitionCursor,
  type Interval,
  type LookedAt,
  cursorMetrics,
} from "./cursorMetrics";

const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const HEADS: HeadMotionKind[] = ["still", "natural"];
const NOISES = ["typical", "low"] as const;
const FIXATIONS = 30;
const DRAW_MS = 1000 / 60;

/**
 * Eyes that don't hold perfectly still: slow drift (a random walk) and microsaccades every 0.5 to
 * 1.5 s that mostly undo it, staying within about 0.8 degrees (40 pt) of the point looked at.
 */
class FixationalEyes extends GazeScript {
  private r: () => number;
  private off = { x: 0, y: 0 };
  private lastT = 0;
  private nextMicro = 0;
  private fixIndex = -1;

  constructor(...args: ConstructorParameters<typeof GazeScript>) {
    super(...args);
    this.r = rng((args[1]?.seed ?? 1) * 4099 + 17);
  }

  override at(tMs: number): GazeTruth {
    const truth = super.at(tMs);
    let i = 0;
    for (let s = 0; i < this.fixations.length && s + this.fixations[i]!.durationMs <= tMs; i++)
      s += this.fixations[i]!.durationMs;
    if (i !== this.fixIndex || !truth.fixation) {
      this.fixIndex = i;
      this.off = { x: 0, y: 0 };
      this.nextMicro = tMs + 500 + this.r() * 1000;
    } else {
      const dt = Math.max(0, tMs - this.lastT) / 1000;
      const drift = 12 * Math.sqrt(dt); // points per sqrt(second)
      this.off.x += gaussian(this.r) * drift;
      this.off.y += gaussian(this.r) * drift;
      if (tMs >= this.nextMicro) {
        // A microsaccade: corrects most of the drift, with its own small error.
        this.off.x = this.off.x * 0.3 + gaussian(this.r) * 8;
        this.off.y = this.off.y * 0.3 + gaussian(this.r) * 8;
        this.nextMicro = tMs + 500 + this.r() * 1000;
      }
      const d = Math.hypot(this.off.x, this.off.y);
      if (d > 40) {
        this.off.x *= 40 / d;
        this.off.y *= 40 / d;
      }
    }
    this.lastT = tMs;
    return { ...truth, x: truth.x + this.off.x, y: truth.y + this.off.y };
  }
}

interface Cursor {
  name: string;
  /** Called with the engine after each camera frame. */
  frame(engine: GazeEngine, t: number): void;
  /** Where the cursor is drawn at time t, or null when it isn't shown. */
  at(engine: GazeEngine, t: number): { x: number; y: number } | null;
}

/** Before: the engine's point on each camera frame, drawn with the 110 ms CSS transition. */
function cssCursor(): Cursor {
  const css = new CssTransitionCursor();
  return {
    name: "before: camera frames + CSS transition",
    frame(engine, t) {
      const p = engine.last?.point;
      if (p) css.set(t, p.x, p.y);
    },
    at(_engine, t) {
      return css.started ? css.at(t) : null;
    },
  };
}

/** After: the engine's cursor (src/cursor.ts), evaluated at every draw time. */
function engineCursor(): Cursor {
  return {
    name: "after: engine cursor, every display frame",
    frame() {},
    at(engine, t) {
      return engine.cursorAt(t);
    },
  };
}

function session(
  seed: number,
  head: HeadMotionKind,
  noise: "low" | "typical",
  makeCursor: () => Cursor,
): CursorMetrics | null {
  const subject = makeSubject(seed, head, NOISE[noise]);
  if (!subject) return null;
  const engine = new GazeEngine({ screen: singleDisplay(DISPLAY.width, DISPLAY.height) });
  engine.setCalibration(subject.v2);
  const cursor = makeCursor();
  const fixations = lookAround(seed + 500, FIXATIONS);
  const script = new FixationalEyes(fixations, { seed: seed + 2000 });
  const start = subject.t;
  const frames = [...simulate(subject.face, script, subject.head, { startMs: start, seed: seed + 9 })];

  const drawn: CursorSample[] = [];
  let drawT = start;
  const draw = (until: number) => {
    for (; drawT < until; drawT += DRAW_MS) {
      const p = cursor.at(engine, drawT);
      if (p) drawn.push({ t: drawT, x: p.x, y: p.y });
    }
  };
  for (const f of frames) {
    draw(f.t);
    engine.handle({
      kind: "face",
      frame: {
        t: f.t,
        landmarks: f.frame.landmarks,
        matrix: f.frame.matrix,
        blink: f.frame.blinkScore,
        aspect: f.frame.aspect,
      },
    });
    cursor.frame(engine, f.t);
  }
  draw(start + script.totalMs);

  // Ground truth: where each fixation's eyes landed (end of the saccade) and when they left.
  const looks: LookedAt[] = [];
  let onset = start;
  for (const fx of fixations) {
    const end = onset + fx.durationMs;
    const landed = frames.find((f) => f.t >= onset && f.t < end && f.truth.fixation);
    if (landed) looks.push({ x: fx.x, y: fx.y, start: landed.t, end });
    onset = end;
  }
  const blinks: Interval[] = [];
  for (const f of frames) {
    if (f.truth.closure <= 0) continue;
    const last = blinks[blinks.length - 1];
    if (last && f.t - last.end < 100) last.end = f.t;
    else blinks.push({ start: f.t, end: f.t });
  }
  return cursorMetrics(drawn, looks, blinks);
}

it("drawn cursor: jitter, lag, accuracy, blinks (simulated)", () => {
  const cursors: (() => Cursor)[] = [cssCursor, engineCursor];
  const rows: Record<string, unknown>[] = [];
  for (const noise of NOISES)
    for (const head of HEADS) {
      for (const make of cursors) {
        const runs = SEEDS.map((s) => session(s, head, noise, make)).filter((m): m is CursorMetrics => !!m);
        const avg = (k: keyof CursorMetrics) => runs.reduce((a, m) => a + m[k], 0) / runs.length;
        const sd = (k: keyof CursorMetrics) => {
          const m = avg(k);
          return Math.sqrt(runs.reduce((a, r) => a + (r[k] - m) ** 2, 0) / runs.length);
        };
        rows.push({
          noise,
          head,
          cursor: make().name,
          people: runs.length,
          jitterPx: avg("jitterPx"),
          jitterSd: sd("jitterPx"),
          stepPx: avg("stepPx"),
          lagMs: avg("lagMs"),
          lagSd: sd("lagMs"),
          accuracyPx: avg("accuracyPx"),
          blinkMovePx: avg("blinkMovePx"),
          closedMovePx: avg("closedMovePx"),
          fixations: runs.reduce((a, m) => a + m.fixations, 0),
          saccades: runs.reduce((a, m) => a + m.saccades, 0),
          blinks: runs.reduce((a, m) => a + m.blinks, 0),
          drawnFps: avg("drawnFps"),
        });
      }
    }
  const f0 = (v: unknown) => (typeof v === "number" ? v.toFixed(0) : String(v));
  const f1 = (v: unknown) => (typeof v === "number" ? v.toFixed(1) : String(v));
  const lines = [
    "| noise | head | cursor | jitter px (sd) | step px/frame | lag ms (sd) | accuracy px | blink move px | moved while closed px | fixations / saccades / blinks |",
    "| ----- | ---- | ------ | -------------- | ------------- | ----------- | ----------- | ------------- | --------------------- | ----------------------------- |",
    ...rows.map(
      (r) =>
        `| ${r.noise} | ${r.head} | ${r.cursor} | ${f1(r.jitterPx)} (${f1(r.jitterSd)}) | ${f1(r.stepPx)} | ${f0(r.lagMs)} (${f0(r.lagSd)}) | ${f1(r.accuracyPx)} | ${f1(r.blinkMovePx)} | ${f1(r.closedMovePx)} | ${r.fixations} / ${r.saccades} / ${r.blinks} |`,
    ),
  ];
  const md = [
    "# Drawn gaze cursor (SIMULATED)",
    "",
    `Synthetic people and webcam (src/synth), typical and low camera noise (bench/lib.ts NOISE), ${SEEDS.length} people per row, ${FIXATIONS} fixations each`,
    "with drift and microsaccades under 1 degree and natural blinks; cursor sampled at 60 Hz. No real person or camera.",
    "Definitions: bench/cursorMetrics.ts. Run: `cd os/gaze && npm run bench:cursor`.",
    "",
    ...lines,
    "",
  ].join("\n");
  console.log(md);
  const dir = resolve(import.meta.dirname, "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "cursor.json"), JSON.stringify({ simulated: true, rows }, null, 2) + "\n");
  writeFileSync(resolve(dir, "cursor.md"), md);
});
