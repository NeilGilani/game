/**
 * Intent benchmark: does fusing gaze with a context prior (src/input/intent.ts) help, and what does it
 * cost when the context is wrong? Run on SIMULATED frames (a synthetic face and eyes, src/synth),
 * through the same GazeEngine the web app runs. No real person or camera is involved: every number
 * here is a simulation result. Real accuracy on a real person comes from the Gaze lab (Settings).
 *
 *   cd os/gaze && npm run bench:intent        (writes bench/results/intent.{json,md})
 *
 * Each look picks a random target in a full-screen grid of same-size targets (24 px gaps), the
 * worst case for telling neighbours apart. Conditions:
 *   - no context: every prior 1. This is exactly the app's 48 px snap before (tested in intent.test.ts).
 *   - context right: the target the person wants is marked likely (prior p).
 *   - context wrong: a neighbour of it is marked likely instead (the person wants something else).
 * With and without prediction (shorter dwell on a predicted arrival at a likely, safe target).
 * Then reading: false selections per minute while reading under a grid with likely targets marked.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { GazeSample, Target } from "../src/contracts";
import { GazeEngine } from "../src/engine";
import { IntentSelector, type IntentSelectorTarget, type PredictOptions } from "../src/input/intent";
import { rng } from "../src/linalg";
import { singleDisplay } from "../src/screen";
import { type Fixation, type HeadMotionKind, readingFixations, type SimFrame } from "../src/synth/scenarios";
import { DISPLAY, NOISE, type Subject, makeSubject, render, targetGrid, toRects } from "./lib";

const SEEDS = Number(process.env.BENCH_SEEDS ?? 6);
const TRIALS = Number(process.env.BENCH_TRIALS ?? 15);
const TRIAL_MS = 8000;
const here = dirname(fileURLToPath(import.meta.url));

interface Step {
  sample: GazeSample | null;
  errorRadius: number;
}

/** The v2 engine exactly as frontend/src/vision/tracker.ts runs it. */
function stream(subject: Subject, frames: readonly SimFrame[]): { t: number; step: Step }[] {
  const engine = new GazeEngine({ screen: singleDisplay(DISPLAY.width, DISPLAY.height) });
  engine.setCalibration(subject.v2);
  let sample: GazeSample | null = null;
  engine.on((e) => {
    if (e.type === "sample") sample = e.sample;
  });
  return frames.map((f) => {
    sample = null;
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
    return { t: f.t, step: { sample, errorRadius: engine.errorRadiusPt } };
  });
}

type Context = "none" | "right" | "wrong";

interface Variant {
  name: string;
  context: Context;
  prior: number;
  prediction: boolean;
  predict?: Partial<PredictOptions>;
}

const PRIORS = [1.25, 1.5, 2, 3];
/** Prediction settings compared (the first is the default in src/input/intent.ts). */
const PREDICTIONS: [string, Partial<PredictOptions>][] = [
  ["(travel 150 px, default)", {}],
  ["(travel 60 px)", { minTravelPx: 60 }],
  ["(travel 300 px)", { minTravelPx: 300 }],
];
const VARIANTS: Variant[] = [
  { name: "no context (= old snap 48 px)", context: "none", prior: 1, prediction: false },
  ...PRIORS.map((p): Variant => ({
    name: `context right, prior ${p}`,
    context: "right",
    prior: p,
    prediction: false,
  })),
  ...PRIORS.map((p): Variant => ({
    name: `context wrong, prior ${p}`,
    context: "wrong",
    prior: p,
    prediction: false,
  })),
  ...PREDICTIONS.flatMap(([label, predict]): Variant[] => [
    {
      name: `context right, prior 1.5 + prediction ${label}`,
      context: "right",
      prior: 1.5,
      prediction: true,
      predict,
    },
    {
      name: `context wrong, prior 1.5 + prediction ${label}`,
      context: "wrong",
      prior: 1.5,
      prediction: true,
      predict,
    },
  ]),
];

interface Trial {
  start: number;
  end: number;
  intended: string;
  /** The neighbour marked likely in the "context wrong" condition. */
  decoy: string;
}

function neighbour(targets: readonly Target[], of: Target, r: () => number): Target {
  const cx = of.rect.x + of.rect.width / 2;
  const cy = of.rect.y + of.rect.height / 2;
  const step = of.rect.width + 24 + 1;
  const near = targets.filter(
    (t) =>
      t !== of && Math.hypot(t.rect.x + t.rect.width / 2 - cx, t.rect.y + t.rect.height / 2 - cy) <= step,
  );
  return near[Math.floor(r() * near.length)] ?? of;
}

function session(subject: Subject, size: number, startMs: number) {
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
    trials.push({
      start: startMs + i * TRIAL_MS,
      end: startMs + (i + 1) * TRIAL_MS,
      intended: target.id,
      decoy: neighbour(targets, target, r).id,
    });
    previous = target;
  }
  return { targets, trials, frames: render(subject, fixations, startMs) };
}

interface Stats {
  trials: number;
  correct: number;
  wrong: number;
  timeouts: number;
  timesMs: number[];
  fast: number;
}

function score(
  steps: readonly { t: number; step: Step }[],
  trials: readonly Trial[],
  targets: readonly Target[],
  v: Variant,
  into: Stats,
): void {
  const rects = toRects(targets);
  const selector = new IntentSelector({
    dwell: { dwellMs: 1200, stabilityPx: 60 },
    prediction: v.prediction,
    predict: v.predict,
  });
  let i = 0;
  for (const trial of trials) {
    const likely = v.context === "right" ? trial.intended : v.context === "wrong" ? trial.decoy : null;
    const list: IntentSelectorTarget[] = rects.map((r) => (r.id === likely ? { ...r, prior: v.prior } : r));
    let activated: { id: string; t: number; fast: boolean } | null = null;
    for (; i < steps.length && steps[i]!.t < trial.end; i++) {
      const { t, step } = steps[i]!;
      if (t < trial.start || !step.sample || activated) continue;
      const u = selector.update({ ...step.sample, errorRadius: step.errorRadius }, list);
      const done = u.events.find((e) => e.type === "activate");
      if (done) activated = { id: done.targetId, t, fast: u.fast || false };
    }
    into.trials++;
    if (!activated) into.timeouts++;
    else {
      if (activated.id === trial.intended) into.correct++;
      else into.wrong++;
      into.timesMs.push(activated.t - trial.start);
    }
  }
}

const quantile = (v: readonly number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};
const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const pct = (a: number, b: number) => (b > 0 ? `${fmt((100 * a) / b)}%` : "n/a");

it("intent benchmark: gaze x context prior, prediction (simulated)", () => {
  const t0 = performance.now();
  const lines: string[] = [];
  const results: Record<string, unknown> = {};
  const motions: HeadMotionKind[] = ["still", "natural"];
  const subjects: Record<string, Subject[]> = {};
  for (const motion of motions)
    for (let seed = 1; seed <= SEEDS; seed++) {
      const s = makeSubject(seed, motion, NOISE.typical);
      if (s) (subjects[motion] ??= []).push(s);
    }

  lines.push(
    `## Selecting a target in a grid of same-size targets (24 px gaps, dwell 1200 ms, ${TRIALS} looks of up to 8 s per person; simulated, typical webcam noise)`,
  );
  lines.push("");
  lines.push("| head | target px | condition | correct | wrong | timeout | median s | p90 s | people |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  const rows: unknown[] = [];
  const errorRadii: number[] = [];
  for (const motion of motions) {
    for (const size of [96, 120]) {
      const stats = new Map<string, Stats>(
        VARIANTS.map((v) => [v.name, { trials: 0, correct: 0, wrong: 0, timeouts: 0, timesMs: [], fast: 0 }]),
      );
      for (const subject of subjects[motion] ?? []) {
        const s = session(subject, size, subject.t + 300_000);
        const steps = stream(subject, s.frames);
        for (const st of steps) if (st.step.sample) errorRadii.push(st.step.errorRadius);
        for (const v of VARIANTS) score(steps, s.trials, s.targets, v, stats.get(v.name)!);
      }
      for (const v of VARIANTS) {
        const st = stats.get(v.name)!;
        const row = {
          motion,
          size,
          condition: v.name,
          trials: st.trials,
          correct: st.correct / st.trials,
          wrong: st.wrong / st.trials,
          timeout: st.timeouts / st.trials,
          medianMs: quantile(st.timesMs, 0.5),
          p90Ms: quantile(st.timesMs, 0.9),
          people: subjects[motion]?.length ?? 0,
        };
        rows.push(row);
        lines.push(
          `| ${motion} | ${size} | ${v.name} | ${pct(st.correct, st.trials)} | ${pct(st.wrong, st.trials)} | ${pct(st.timeouts, st.trials)} | ${fmt(row.medianMs / 1000, 2)} | ${fmt(row.p90Ms / 1000, 2)} | ${row.people} |`,
        );
      }
    }
  }
  results.selection = rows;

  // Break-even: how often the context must be right for a prior to pay off (correct selections).
  lines.push("");
  lines.push("### When does a prior pay off? (all rows above pooled)");
  lines.push("");
  lines.push(
    "| prior | correct, no context | correct, context right | correct, context wrong | context must be right at least |",
  );
  lines.push("|---|---|---|---|---|");
  const pooled = (name: string) => {
    const rs = rows.filter((r) => (r as { condition: string }).condition === name) as {
      correct: number;
      trials: number;
    }[];
    const n = rs.reduce((a, r) => a + r.trials, 0);
    return rs.reduce((a, r) => a + r.correct * r.trials, 0) / n;
  };
  const base = pooled("no context (= old snap 48 px)");
  const breakEven: unknown[] = [];
  for (const p of PRIORS) {
    const right = pooled(`context right, prior ${p}`);
    const wrong = pooled(`context wrong, prior ${p}`);
    const gain = right - base;
    const loss = base - wrong;
    const needed = gain <= 0 ? NaN : loss <= 0 ? 0 : loss / (gain + loss);
    breakEven.push({ prior: p, base, right, wrong, needed });
    lines.push(
      `| ${p} | ${fmt(base * 100)}% | ${fmt(right * 100)}% | ${fmt(wrong * 100)}% | ${Number.isFinite(needed) ? `${fmt(needed * 100)}% of the time` : "never (no gain)"} |`,
    );
  }
  results.breakEven = breakEven;
  results.errorRadius = {
    median: quantile(errorRadii, 0.5),
    p10: quantile(errorRadii, 0.1),
    p90: quantile(errorRadii, 0.9),
  };
  lines.push("");
  lines.push(
    `Error radius the engine reported during these looks (px, about 2 sigma): median ${fmt(quantile(errorRadii, 0.5))}, 10th percentile ${fmt(quantile(errorRadii, 0.1))}, 90th ${fmt(quantile(errorRadii, 0.9))}.`,
  );

  // --- Reading under likely targets ------------------------------------------------------------
  lines.push("");
  lines.push(
    "## Selections nobody wanted while reading (three pages under a grid of 96 px targets, 1 in 8 marked likely, prior 1.5; simulated)",
  );
  lines.push("");
  lines.push("| head | condition | per minute | minutes |");
  lines.push("|---|---|---|---|");
  const reading: unknown[] = [];
  const grid = toRects(targetGrid(96, 24));
  for (const motion of motions) {
    const totals = new Map<string, { n: number; minutes: number }>();
    for (const subject of subjects[motion] ?? []) {
      const fixations: Fixation[] = [];
      for (let page = 0; page < 3; page++)
        fixations.push(...readingFixations(DISPLAY, { seed: subject.seed * 10 + page, lines: 14 }));
      const frames = render(subject, fixations, subject.t + 900_000);
      const steps = stream(subject, frames);
      const r = rng(subject.seed * 31 + 5);
      const marked = grid.map((g) => (r() < 1 / 8 ? { ...g, prior: 1.5 } : g));
      const conditions: [string, IntentSelectorTarget[], boolean, Partial<PredictOptions>?][] = [
        ["no context (= old snap 48 px)", grid, false],
        ["likely targets, prior 1.5", marked, false],
        ...PREDICTIONS.map(
          ([label, predict]): [string, IntentSelectorTarget[], boolean, Partial<PredictOptions>] => [
            `likely targets, prior 1.5 + prediction ${label}`,
            marked,
            true,
            predict,
          ],
        ),
      ];
      const minutes = (steps.at(-1)!.t - steps[0]!.t) / 60_000;
      for (const [name, list, prediction, predict] of conditions) {
        const sel = new IntentSelector({ dwell: { dwellMs: 1200, stabilityPx: 60 }, prediction, predict });
        let n = 0;
        for (const { step } of steps) {
          if (!step.sample) continue;
          if (
            sel
              .update({ ...step.sample, errorRadius: step.errorRadius }, list)
              .events.some((e) => e.type === "activate")
          )
            n++;
        }
        const acc = totals.get(name) ?? { n: 0, minutes: 0 };
        acc.n += n;
        acc.minutes += minutes;
        totals.set(name, acc);
      }
    }
    for (const [name, acc] of totals) {
      const row = { motion, condition: name, perMinute: acc.n / acc.minutes, minutes: acc.minutes };
      reading.push(row);
      lines.push(`| ${motion} | ${name} | ${fmt(row.perMinute, 2)} | ${fmt(row.minutes, 1)} |`);
    }
  }
  results.reading = reading;

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
  writeFileSync(join(here, "results", "intent.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(here, "results", "intent.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
});
