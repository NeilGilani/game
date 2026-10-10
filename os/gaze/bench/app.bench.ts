/**
 * App benchmark: the web app's eye control BEFORE and AFTER it moved to the v2 engine, on identical
 * SIMULATED frames (a synthetic face and eyes, src/synth). No real person or camera is involved, so
 * every number here is a simulation result, not a measurement of a person.
 *
 *   cd os/gaze && npm run bench:app        (writes bench/results/app.{json,md})
 *
 * Before: bench/oldApp.ts, the pipeline people used until now (9-point legacy calibration, One Euro
 * filter, fixation-lock stabilizer; 48 px snap and dwell 1200 ms / 60 px in InputLayer).
 * After: GazeEngine (calibration v2, fixation smoothing), as frontend/src/vision/tracker.ts runs it,
 * with the app's 48 px snap and dwell (InputLayer.tsx), and with GazeSelector (target magnetism).
 * Variants answer the design questions: does the old stabilizer still help on top of v2, and should
 * the dwell's steadiness rule read the pointer or the magnet's lock?
 *
 * The viewport is the whole simulated display (1470 x 956 pt, a 13-inch MacBook Air), as with the
 * Mac app's full-screen shell. Targets are AGENCY's minimum, 96 px with 24 px gaps, and larger.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { GazeSample, Target } from "../src/contracts";
import { GazeEngine } from "../src/engine";
import { DwellEngine } from "../src/input/dwell";
import { GazeSelector, type Steadiness } from "../src/input/selector";
import { findTarget } from "../src/input/targets";
import { rng } from "../src/linalg";
import { singleDisplay } from "../src/screen";
import { type Fixation, type HeadMotionKind, readingFixations, type SimFrame } from "../src/synth/scenarios";
import {
  DISPLAY,
  NOISE,
  type Subject,
  type UseMetrics,
  lookAround,
  makeSubject,
  measureUse,
  render,
  targetGrid,
  toRects,
} from "./lib";
import { GazeStabilizer, oldAppPipeline } from "./oldApp";

const SEEDS = Number(process.env.BENCH_SEEDS ?? 8);
const TRIALS = Number(process.env.BENCH_TRIALS ?? 15);
const TRIAL_MS = 8000;
const here = dirname(fileURLToPath(import.meta.url));

type Point = { x: number; y: number };

interface Step {
  sample: GazeSample | null;
  raw: Point | null;
  /** About two standard deviations of the pointer's error (px), as the app passes to the magnet. */
  errorRadius: number;
  computeMs: number;
}

interface PointerPipeline {
  name: string;
  step(f: SimFrame): Step;
}

function before(s: Subject): PointerPipeline {
  const p = oldAppPipeline(s.v1, DISPLAY);
  return { name: "before", step: (f) => ({ ...p.step(f), errorRadius: 0 }) };
}

function after(s: Subject, options: { stabilizer?: boolean } = {}): PointerPipeline {
  const engine = new GazeEngine({ screen: singleDisplay(DISPLAY.width, DISPLAY.height) });
  engine.setCalibration(s.v2);
  const stabilizer = options.stabilizer ? new GazeStabilizer({ radius: 60 }) : null;
  const box: { sample: GazeSample | null; shown: Point | null } = { sample: null, shown: null };
  engine.on((e) => {
    if (e.type === "sample") box.sample = e.sample;
  });
  return {
    name: options.stabilizer ? "v2 + old stabilizer" : "v2",
    step(f) {
      box.sample = null;
      const start = performance.now();
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
      const raw = engine.last?.raw ?? null;
      let sample = box.sample as GazeSample | null;
      if (sample && stabilizer) {
        // Fresh estimates go through the stabilizer; held positions (blinks) stay where they were.
        box.shown = raw || !box.shown ? stabilizer.update(sample) : box.shown;
        sample = { ...sample, x: box.shown.x, y: box.shown.y };
      }
      return { sample, raw, errorRadius: engine.errorRadiusPt, computeMs: performance.now() - start };
    },
  };
}

interface Choice {
  activated: string | null;
  /** The target the person sees highlighted (old: the dwell's active target; new: the lock). */
  highlight: string | null;
}

interface Chooser {
  name: string;
  update(s: GazeSample, errorRadius: number): Choice;
}

/** InputLayer before: hit-test with a 48 px snap, dwell 1200 ms needing the pointer within 60 px. */
function snapChooser(targets: readonly Target[]): Chooser {
  const rects = toRects(targets);
  const dwell = new DwellEngine({ dwellMs: 1200, stabilityPx: 60 });
  return {
    name: "snap 48 px",
    update(s) {
      const id = findTarget(s.x, s.y, rects, 48);
      const events = dwell.update({ t: s.t, x: s.x, y: s.y, confidence: s.confidence, targetId: id });
      const done = events.find((e) => e.type === "activate");
      return { activated: done ? done.targetId : null, highlight: dwell.snapshot().targetId };
    },
  };
}

/** InputLayer after: target magnetism with adaptive reach and hysteresis, then dwell. */
function magnetChooser(targets: readonly Target[], steadiness: Steadiness): Chooser {
  const rects = toRects(targets);
  const selector = new GazeSelector({
    dwell: { dwellMs: 1200, stabilityPx: 60 },
    magnet: { snapPx: 48 },
    steadiness,
  });
  return {
    name: `magnet, steadiness on ${steadiness}`,
    update(s, errorRadius) {
      const events = selector.update({ ...s, errorRadius }, rects);
      const done = events.find((e) => e.type === "selected");
      return { activated: done ? done.targetId : null, highlight: selector.locked };
    },
  };
}

interface Trial {
  start: number;
  end: number;
  intended: string;
}

/** One continuous session: look at TRIALS random targets in turn, TRIAL_MS each (natural blinks). */
function selectionSession(subject: Subject, size: number, startMs: number) {
  const targets = targetGrid(size, 24);
  const r = rng(subject.seed * 7919 + size);
  const fixations: Fixation[] = [];
  const trials: Trial[] = [];
  let previous: Target | null = null;
  for (let i = 0; i < TRIALS; i++) {
    let target = targets[Math.floor(r() * targets.length)]!;
    while (target === previous) target = targets[Math.floor(r() * targets.length)]!;
    fixations.push({
      x: target.rect.x + target.rect.width / 2,
      y: target.rect.y + target.rect.height / 2,
      durationMs: TRIAL_MS,
    });
    trials.push({ start: startMs + i * TRIAL_MS, end: startMs + (i + 1) * TRIAL_MS, intended: target.id });
    previous = target;
  }
  return { targets, trials, frames: render(subject, fixations, startMs) };
}

interface SelectionStats {
  trials: number;
  correct: number;
  wrong: number;
  timeouts: number;
  timesMs: number[];
  /** Highlight changes from 300 ms after the eyes set off until the selection (or the trial's end). */
  flips: number[];
  /** Share of time, from 500 ms on, that the intended target is the one highlighted. */
  onTarget: number[];
}

const emptyStats = (): SelectionStats => ({
  trials: 0,
  correct: 0,
  wrong: 0,
  timeouts: 0,
  timesMs: [],
  flips: [],
  onTarget: [],
});

function scoreSelection(
  steps: readonly { t: number; step: Step }[],
  trials: readonly Trial[],
  chooser: Chooser,
  into: SelectionStats,
): void {
  let i = 0;
  for (const trial of trials) {
    let activated: { id: string; t: number } | null = null;
    let flips = 0;
    let last: string | null | undefined;
    let on = 0;
    let total = 0;
    for (; i < steps.length && steps[i]!.t < trial.end; i++) {
      const { t, step } = steps[i]!;
      if (t < trial.start || !step.sample) continue;
      const c = chooser.update(step.sample, step.errorRadius);
      if (activated) continue;
      if (c.activated) {
        activated = { id: c.activated, t };
        continue;
      }
      if (t >= trial.start + 300) {
        if (last !== undefined && c.highlight !== last) flips++;
        last = c.highlight;
      }
      if (t >= trial.start + 500) {
        total++;
        if (c.highlight === trial.intended) on++;
      }
    }
    into.trials++;
    if (!activated) into.timeouts++;
    else {
      if (activated.id === trial.intended) into.correct++;
      else into.wrong++;
      into.timesMs.push(activated.t - trial.start);
    }
    into.flips.push(flips);
    if (total > 0) into.onTarget.push(on / total);
  }
}

/** False selections per minute while reading three pages laid out under a grid of 96 px targets. */
function readingActivations(
  steps: readonly { t: number; step: Step }[],
  chooser: Chooser,
): { perMinute: number; minutes: number } {
  let n = 0;
  for (const { step } of steps)
    if (step.sample && chooser.update(step.sample, step.errorRadius).activated) n++;
  const minutes = (steps.at(-1)!.t - steps[0]!.t) / 60_000;
  return { perMinute: n / minutes, minutes };
}

const mean = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const quantile = (v: readonly number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};
const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const pct = (a: number, b: number) => (b > 0 ? `${fmt((100 * a) / b)}%` : "n/a");

type PointerKind = "before" | "v2" | "v2 + old stabilizer";
type ChooserKind = "snap" | Steadiness;

/** Which pointer feeds which chooser: "before" is the old app; the rest are v2 variants. */
const COMBOS: [PointerKind, ChooserKind][] = [
  ["before", "snap"],
  ["v2", "snap"],
  ["v2", "pointer"],
  ["v2", "adaptive"],
  ["v2", "lock"],
  ["v2 + old stabilizer", "pointer"],
  ["v2 + old stabilizer", "lock"],
];

function pipelines(subject: Subject): Record<PointerKind, PointerPipeline> {
  return {
    before: before(subject),
    v2: after(subject),
    "v2 + old stabilizer": after(subject, { stabilizer: true }),
  };
}

function chooserFor(kind: ChooserKind, targets: readonly Target[]): Chooser {
  return kind === "snap" ? snapChooser(targets) : magnetChooser(targets, kind);
}

const label = ([p, c]: [PointerKind, ChooserKind]) =>
  `${p === "before" ? "before (old app)" : p} / ${c === "snap" ? "snap 48 px" : `magnet, steadiness: ${c}`}`;

it("app benchmark: eye control before and after (simulated)", () => {
  const t0 = performance.now();
  const lines: string[] = [];
  const results: Record<string, unknown> = {};
  const motions: HeadMotionKind[] = ["still", "natural"];

  // --- Pointer accuracy and steadiness -------------------------------------------------------
  const use: Record<string, Record<PointerKind, UseMetrics[]>> = {};
  const subjects: Record<string, Subject[]> = {};
  for (const motion of motions) {
    use[motion] = { before: [], v2: [], "v2 + old stabilizer": [] };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const subject = makeSubject(seed, motion, NOISE.typical);
      if (!subject) continue;
      (subjects[motion] ??= []).push(subject);
      const fixations = lookAround(seed, 30);
      const frames = render(subject, fixations);
      const p = pipelines(subject);
      for (const kind of Object.keys(p) as PointerKind[])
        use[motion]![kind].push(measureUse(frames, fixations, subject.t, p[kind]));
    }
  }
  lines.push("## Pointer accuracy and steadiness (simulated, typical webcam noise, looking around)");
  lines.push("");
  lines.push(
    "| head | pipeline | accuracy pt | steadiness: RMS while fixating pt | settle after a jump ms | people |",
  );
  lines.push("|---|---|---|---|---|---|");
  const pointerRows: unknown[] = [];
  for (const motion of motions)
    for (const kind of ["before", "v2", "v2 + old stabilizer"] as PointerKind[]) {
      const m = use[motion]![kind];
      const row = {
        motion,
        pipeline: kind,
        accuracyPt: mean(m.map((x) => x.accuracyPt)),
        precisionPt: mean(m.map((x) => x.precisionPt)),
        settleMs: mean(m.map((x) => x.settleMs)),
        people: m.length,
      };
      pointerRows.push(row);
      lines.push(
        `| ${motion} | ${kind === "before" ? "before (old app)" : kind} | ${fmt(row.accuracyPt)} | ${fmt(row.precisionPt)} | ${fmt(row.settleMs)} | ${row.people} |`,
      );
    }
  results.pointer = pointerRows;

  // --- Selecting targets ---------------------------------------------------------------------
  lines.push("");
  lines.push(
    `## Selecting a target among same-size targets (24 px gaps, dwell 1200 ms, ${TRIALS} looks of up to 8 s per person and size; simulated)`,
  );
  lines.push("");
  lines.push(
    "| head | target px | pipeline / selection | correct | wrong | timeout | median s | p90 s | highlight changes per look | intended target highlighted |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  const selectionRows: unknown[] = [];
  for (const motion of motions) {
    for (const size of [96, 120, 160]) {
      const stats = new Map<string, SelectionStats>(COMBOS.map((c) => [label(c), emptyStats()]));
      for (const subject of subjects[motion] ?? []) {
        const session = selectionSession(subject, size, subject.t + 300_000);
        const p = pipelines(subject);
        const streams = new Map<PointerKind, { t: number; step: Step }[]>();
        for (const kind of Object.keys(p) as PointerKind[])
          streams.set(
            kind,
            session.frames.map((f) => ({ t: f.t, step: p[kind].step(f) })),
          );
        for (const combo of COMBOS)
          scoreSelection(
            streams.get(combo[0])!,
            session.trials,
            chooserFor(combo[1], session.targets),
            stats.get(label(combo))!,
          );
      }
      for (const combo of COMBOS) {
        const s = stats.get(label(combo))!;
        const row = {
          motion,
          size,
          pipeline: label(combo),
          trials: s.trials,
          correct: s.correct / s.trials,
          wrong: s.wrong / s.trials,
          timeout: s.timeouts / s.trials,
          medianMs: quantile(s.timesMs, 0.5),
          p90Ms: quantile(s.timesMs, 0.9),
          flipsPerLook: mean(s.flips),
          onTarget: mean(s.onTarget),
        };
        selectionRows.push(row);
        lines.push(
          `| ${motion} | ${size} | ${label(combo)} | ${pct(s.correct, s.trials)} | ${pct(s.wrong, s.trials)} | ${pct(s.timeouts, s.trials)} | ${fmt(row.medianMs / 1000, 1)} | ${fmt(row.p90Ms / 1000, 1)} | ${fmt(row.flipsPerLook, 1)} | ${fmt(row.onTarget * 100)}% |`,
        );
      }
    }
  }
  results.selection = selectionRows;

  // --- Reading without selecting -------------------------------------------------------------
  lines.push("");
  lines.push(
    "## Selections nobody wanted while reading (three pages of text under a grid of 96 px targets; simulated)",
  );
  lines.push("");
  lines.push("| head | pipeline / selection | per minute | minutes |");
  lines.push("|---|---|---|---|");
  const readingRows: unknown[] = [];
  const grid = targetGrid(96, 24);
  for (const motion of motions) {
    const totals = new Map<string, { n: number; minutes: number }>();
    for (const subject of subjects[motion] ?? []) {
      const fixations: Fixation[] = [];
      for (let page = 0; page < 3; page++)
        fixations.push(...readingFixations(DISPLAY, { seed: subject.seed * 10 + page, lines: 14 }));
      const frames = render(subject, fixations, subject.t + 900_000);
      const p = pipelines(subject);
      const streams = new Map<PointerKind, { t: number; step: Step }[]>();
      for (const kind of Object.keys(p) as PointerKind[])
        streams.set(
          kind,
          frames.map((f) => ({ t: f.t, step: p[kind].step(f) })),
        );
      for (const combo of COMBOS) {
        const r = readingActivations(streams.get(combo[0])!, chooserFor(combo[1], grid));
        const acc = totals.get(label(combo)) ?? { n: 0, minutes: 0 };
        acc.n += r.perMinute * r.minutes;
        acc.minutes += r.minutes;
        totals.set(label(combo), acc);
      }
    }
    for (const combo of COMBOS) {
      const acc = totals.get(label(combo))!;
      const row = { motion, pipeline: label(combo), perMinute: acc.n / acc.minutes, minutes: acc.minutes };
      readingRows.push(row);
      lines.push(`| ${motion} | ${label(combo)} | ${fmt(row.perMinute, 2)} | ${fmt(row.minutes, 1)} |`);
    }
  }
  results.reading = readingRows;

  results.meta = {
    simulated: true,
    seeds: SEEDS,
    trials: TRIALS,
    noise: "typical",
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ranAt: new Date().toISOString(),
    runtimeS: (performance.now() - t0) / 1000,
  };
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(join(here, "results", "app.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(here, "results", "app.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
});
