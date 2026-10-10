/**
 * Pipeline benchmark: accuracy, precision, settling lag, false activations while reading,
 * selection time, continuous recalibration under drift, and per-frame compute time.
 * v1 (current web-app pipeline) vs v2 (this engine), on identical SIMULATED frames.
 *
 *   cd os/gaze && npm run bench            (writes bench/results/pipeline.json)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { Target } from "../src/contracts";
import { magnifiedTargets } from "../src/precision";
import {
  type Fixation,
  GazeScript,
  HeadMotion,
  type HeadMotionKind,
  readingFixations,
  simulate,
  type SimFrame,
} from "../src/synth/scenarios";
import type { HeadState } from "../src/synth/face";
import { rng } from "../src/linalg";
import {
  DISPLAY,
  NOISE,
  type Pipeline,
  type Subject,
  type UseMetrics,
  dwellRunner,
  lookAround,
  makeSubject,
  measureUse,
  render,
  targetGrid,
  v1Pipeline,
  v2Pipeline,
} from "./lib";

const SEEDS = Number(process.env.BENCH_SEEDS ?? 10);
const here = dirname(fileURLToPath(import.meta.url));

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const sd = (v: number[]) => {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
};
const q = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};
const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

/** False dwell activations per minute while reading a page that is entirely 96 pt targets. */
function readingFalseActivations(frames: readonly SimFrame[], pipeline: Pipeline, targets: Target[]): number {
  const run = dwellRunner(targets);
  let activations = 0;
  for (const f of frames) {
    const r = pipeline.step(f);
    if (r.sample) activations += run(r.sample).length;
  }
  const minutes = (frames.at(-1)!.t - frames[0]!.t) / 60_000;
  return activations / minutes;
}

interface SelectionResult {
  timesMs: number[];
  correct: number;
  wrong: number;
  timeouts: number;
  pickerUsed: number;
}

/**
 * Selection trials: look at an intended target among a grid of same-size targets until something
 * is selected (or 8 s pass). With `picker`, v2's "which one?" decision is used: when the dwell
 * lands on an ambiguous target, a picker appears and the person looks at the right button.
 */
function selectionTrials(
  subject: Subject,
  make: () => Pipeline & {
    engine?: { precision: (t: Target[]) => ReturnType<import("../src/engine").GazeEngine["precision"]> };
  },
  size: number,
  trials: number,
  startMs: number,
  picker = false,
): SelectionResult {
  const targets = targetGrid(size, Math.max(24, size * 0.25));
  const r = rng(subject.seed * 31 + size);
  const res: SelectionResult = { timesMs: [], correct: 0, wrong: 0, timeouts: 0, pickerUsed: 0 };
  let t = startMs;
  let prev = { x: DISPLAY.width / 2, y: DISPLAY.height / 2 };
  for (let i = 0; i < trials; i++) {
    const intended = targets[Math.floor(r() * targets.length)]!;
    const goal = {
      x: intended.rect.x + intended.rect.width / 2,
      y: intended.rect.y + intended.rect.height / 2,
    };
    const pipeline = make();
    const dwell = dwellRunner(targets);
    let phase:
      { kind: "look" } | { kind: "picker"; buttons: { targetId: string | null; rect: Target["rect"] }[] } = {
      kind: "look",
    };
    let pickerDwell: ((s: import("../src/contracts").GazeSample) => string[]) | null = null;
    let look = goal;
    let lookFrom = prev;
    let segmentStart = t;
    let done = false;
    let askedThisFixation = false;
    const begin = t;
    while (!done && t - begin < 8000) {
      const script = new GazeScript(
        [
          { x: lookFrom.x, y: lookFrom.y, durationMs: 1 },
          { x: look.x, y: look.y, durationMs: 8000 },
        ],
        { seed: subject.seed * 7 + i },
      );
      let switched = false;
      for (const f of simulate(subject.face, script, subject.head, { startMs: segmentStart, seed: i })) {
        t = f.t;
        if (t - begin >= 8000) break;
        const out = pipeline.step(f);
        if (!out.sample) continue;
        if (phase.kind === "picker") {
          const chosen = pickerDwell!(out.sample);
          if (chosen.length) {
            const id = chosen[0]!;
            if (id === intended.id) res.correct++;
            else if (id !== "none") res.wrong++;
            if (id !== "none") {
              res.timesMs.push(t - begin);
              done = true;
              break;
            }
            phase = { kind: "look" };
            askedThisFixation = false;
            lookFrom = look;
            look = goal;
            segmentStart = t + 33;
            switched = true;
            break;
          }
          continue;
        }
        const activated = dwell(out.sample);
        // With helpers: once the eyes have held a fixation for 600 ms, ask the engine whether the
        // targets there are ambiguous (or a dwell just finished on one) and offer a picker/lens.
        const engine = pipeline.engine as unknown as import("../src/engine").GazeEngine | undefined;
        const askNow =
          picker &&
          engine &&
          out.sample.confidence >= 0.5 &&
          (engine.fixationMs >= 600 || activated.length > 0);
        if (askNow && !askedThisFixation) {
          askedThisFixation = true;
          const decision = engine.precision(targets);
          if (decision.kind === "picker") {
            res.pickerUsed++;
            const buttons = decision.buttons.map((b) => ({ targetId: b.targetId ?? "none", rect: b.rect }));
            phase = { kind: "picker", buttons };
            const pickTargets: Target[] = buttons.map((b) => ({
              id: b.targetId!,
              rect: b.rect,
              role: "button",
              label: b.targetId!,
              source: "overlay",
            }));
            pickerDwell = dwellRunner(pickTargets);
            const mine =
              buttons.find((b) => b.targetId === intended.id) ?? buttons.find((b) => b.targetId === "none")!;
            lookFrom = look;
            look = { x: mine.rect.x + mine.rect.width / 2, y: mine.rect.y + mine.rect.height / 2 };
            segmentStart = t + 33;
            switched = true;
            break;
          }
          if (decision.kind === "magnify") {
            res.pickerUsed++;
            const candidates = targets.filter((x) => decision.candidates.includes(x.id));
            const lensTargets = magnifiedTargets(decision, candidates);
            const close: Target = {
              id: "none",
              rect: {
                x: decision.lens.x + decision.lens.width / 2 - 120,
                y: decision.lens.y + decision.lens.height + 24,
                width: 240,
                height: 120,
              },
              role: "button",
              label: "Close",
              source: "overlay",
            };
            // If the lens would push Close off the display, put it above the lens instead.
            if (close.rect.y + close.rect.height > DISPLAY.height)
              close.rect.y = Math.max(0, decision.lens.y - 144);
            const buttons = [...lensTargets, close].map((b) => ({ targetId: b.id, rect: b.rect }));
            phase = { kind: "picker", buttons };
            pickerDwell = dwellRunner([...lensTargets, close]);
            const mine =
              buttons.find((b) => b.targetId === intended.id) ?? buttons.find((b) => b.targetId === "none")!;
            lookFrom = look;
            look = { x: mine.rect.x + mine.rect.width / 2, y: mine.rect.y + mine.rect.height / 2 };
            segmentStart = t + 33;
            switched = true;
            break;
          }
        }
        if (engine && engine.fixationMs === 0) askedThisFixation = false;
        if (activated.length === 0) continue;
        const id = activated[0]!;
        if (id === intended.id) res.correct++;
        else res.wrong++;
        res.timesMs.push(t - begin);
        done = true;
        break;
      }
      if (!switched && !done) break;
    }
    if (!done) res.timeouts++;
    t += 1500;
    prev = look;
  }
  return res;
}

/** The head slowly slumps (3 cm down, 6 cm back, 6 degrees pitch) over two minutes. */
class SlumpingHead extends HeadMotion {
  constructor(
    seed: number,
    private readonly t0: number,
  ) {
    super({ kind: "still", seed });
  }

  override at(tMs: number): HeadState {
    const h = super.at(tMs);
    const k = Math.max(0, Math.min(1, (tMs - this.t0) / 120_000));
    return {
      ...h,
      position: [h.position[0], h.position[1] + 3 * k, h.position[2] + 6 * k],
      pitchDeg: h.pitchDeg + 6 * k,
    };
  }
}

/** Continuous recalibration: select 120 pt targets for ~4 minutes while the head slumps. */
function driftRun(subject: Subject, continuous: boolean) {
  const targets = targetGrid(120, 30);
  const head = new SlumpingHead(subject.seed, subject.t);
  const pipeline = v2Pipeline(subject.v2, { continuous });
  const r = rng(subject.seed * 13 + 5);
  const errors: { t: number; e: number }[] = [];
  let t = subject.t;
  let prev = { x: DISPLAY.width / 2, y: DISPLAY.height / 2 };
  let correct = 0;
  let wrong = 0;
  let advice = 0;
  pipeline.engine.onAdvice((a) => {
    if (a.type === "recalibrate") advice++;
  });
  while (t < subject.t + 240_000) {
    const intended = targets[Math.floor(r() * targets.length)]!;
    const goal = { x: intended.rect.x + 60, y: intended.rect.y + 60 };
    const dwell = dwellRunner(targets);
    const script = new GazeScript(
      [
        { x: prev.x, y: prev.y, durationMs: 1 },
        { x: goal.x, y: goal.y, durationMs: 4000 },
      ],
      { seed: Math.floor(t) },
    );
    const segStart = t;
    const pts: { x: number; y: number }[] = [];
    for (const f of simulate(subject.face, script, head, { startMs: t, seed: Math.floor(t) % 1000 })) {
      t = f.t;
      const out = pipeline.step(f);
      if (!out.sample) continue;
      if (f.t - segStart > 400) pts.push(out.sample);
      const ids = dwell(out.sample);
      if (ids.length) {
        const chosen = targets.find((x) => x.id === ids[0])!;
        if (continuous) pipeline.engine.selection(chosen.id, chosen.rect, f.t, f.t - 1200);
        if (ids[0] === intended.id) correct++;
        else {
          wrong++;
          // The person notices and undoes it (when they can), two seconds later.
          if (continuous) pipeline.engine.undo(chosen.id, f.t + 2000);
        }
        break;
      }
    }
    if (pts.length) {
      const late = pts.slice(-15);
      const mx = late.reduce((a, p) => a + p.x, 0) / late.length;
      const my = late.reduce((a, p) => a + p.y, 0) / late.length;
      errors.push({ t: t - subject.t, e: Math.hypot(mx - goal.x, my - goal.y) });
    }
    t += 600;
    prev = goal;
  }
  const first = errors.filter((e) => e.t < 30_000).map((e) => e.e);
  const last = errors.filter((e) => e.t > 180_000).map((e) => e.e);
  return { firstPt: mean(first), lastPt: mean(last), correct, wrong, advice };
}

it("pipeline benchmark", () => {
  const motions: HeadMotionKind[] = ["still", "natural", "moving"];
  const results: Record<string, unknown> = {};
  const lines: string[] = [];
  const t0 = performance.now();

  // --- Accuracy and precision -------------------------------------------------------------
  const table: Record<
    string,
    Record<
      string,
      { v1: UseMetrics[]; v2: UseMetrics[]; cal: number[]; calDeg: number[]; pts: number[]; failed: number }
    >
  > = {};
  const subjects: Record<string, Subject[]> = {};
  const calTimes: number[] = [];
  for (const noise of ["low", "typical", "high"] as const) {
    table[noise] = {};
    for (const motion of motions) {
      const cell = {
        v1: [] as UseMetrics[],
        v2: [] as UseMetrics[],
        cal: [] as number[],
        calDeg: [] as number[],
        pts: [] as number[],
        failed: 0,
      };
      table[noise]![motion] = cell;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const c0 = performance.now();
        const subject = makeSubject(seed, motion, NOISE[noise]);
        calTimes.push(performance.now() - c0);
        if (!subject) {
          cell.failed++;
          continue;
        }
        (subjects[`${noise}/${motion}`] ??= []).push(subject);
        cell.cal.push(subject.v2.quality.meanErrorPt);
        cell.calDeg.push(subject.v2.quality.meanErrorDeg ?? NaN);
        cell.pts.push(subject.v2.trainingTargets);
        const fixations = lookAround(seed, 30);
        const frames = render(subject, fixations);
        cell.v1.push(measureUse(frames, fixations, subject.t, v1Pipeline(subject.v1)));
        cell.v2.push(measureUse(frames, fixations, subject.t, v2Pipeline(subject.v2)));
      }
    }
  }
  const acc: unknown[] = [];
  lines.push("## Accuracy and precision (simulated, look-around after calibration)");
  lines.push(
    "| noise | head | pipeline | accuracy pt (sd) | accuracy deg | precision pt | precision deg | raw precision pt | settle ms | usable | calib. reported pt / deg | training points |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const noise of ["low", "typical", "high"] as const)
    for (const motion of motions) {
      const cell = table[noise]![motion]!;
      for (const which of ["v1", "v2"] as const) {
        const m = cell[which];
        const row = {
          noise,
          motion,
          pipeline: which,
          subjects: m.length,
          failedCalibrations: cell.failed,
          accuracyPt: mean(m.map((x) => x.accuracyPt)),
          accuracyPtSd: sd(m.map((x) => x.accuracyPt)),
          accuracyDeg: mean(m.map((x) => x.accuracyDeg)),
          precisionPt: mean(m.map((x) => x.precisionPt)),
          precisionDeg: mean(m.map((x) => x.precisionDeg)),
          rawAccuracyPt: mean(m.map((x) => x.rawAccuracyPt)),
          rawPrecisionPt: mean(m.map((x) => x.rawPrecisionPt)),
          settleMs: mean(m.map((x) => x.settleMs)),
          usable: mean(m.map((x) => x.usable)),
          computeMsPerFrame: mean(m.map((x) => x.computeMsPerFrame)),
          reportedCalibrationPt: which === "v2" ? mean(cell.cal) : null,
          reportedCalibrationDeg: which === "v2" ? mean(cell.calDeg) : null,
          trainingPoints: which === "v2" ? mean(cell.pts) : 9,
        };
        acc.push(row);
        lines.push(
          `| ${noise} | ${motion} | ${which} | ${fmt(row.accuracyPt)} (${fmt(row.accuracyPtSd)}) | ${fmt(row.accuracyDeg, 2)} | ${fmt(row.precisionPt)} | ${fmt(row.precisionDeg, 2)} | ${fmt(row.rawPrecisionPt)} | ${fmt(row.settleMs)} | ${fmt(row.usable * 100)}% | ${which === "v2" ? `${fmt(mean(cell.cal))} / ${fmt(mean(cell.calDeg), 2)}` : "-"} | ${fmt(row.trainingPoints, 1)} |`,
        );
      }
    }
  results.accuracy = acc;

  // --- False activations while reading ------------------------------------------------------
  lines.push(
    "",
    "## False activations per minute while reading (page fully covered by 96 pt targets, 24 pt gaps)",
  );
  lines.push("| head | v1 per min | v2 per min | minutes simulated per pipeline |");
  lines.push("|---|---|---|---|");
  const reading: unknown[] = [];
  const grid96 = targetGrid(96, 24);
  for (const motion of motions) {
    const list = subjects[`typical/${motion}`] ?? [];
    let v1 = 0;
    let v2 = 0;
    let minutes = 0;
    for (const s of list) {
      const fix: Fixation[] = [];
      for (let page = 0; page < 3; page++)
        fix.push(...readingFixations(DISPLAY, { seed: s.seed * 10 + page, lines: 14 }));
      const frames = render(s, fix, s.t + 100_000);
      const mins = (frames.at(-1)!.t - frames[0]!.t) / 60_000;
      minutes += mins;
      v1 += readingFalseActivations(frames, v1Pipeline(s.v1), grid96) * mins;
      v2 += readingFalseActivations(frames, v2Pipeline(s.v2), grid96) * mins;
    }
    const row = { motion, v1PerMin: v1 / minutes, v2PerMin: v2 / minutes, minutes };
    reading.push(row);
    lines.push(`| ${motion} | ${fmt(row.v1PerMin, 2)} | ${fmt(row.v2PerMin, 2)} | ${fmt(minutes, 1)} |`);
  }
  results.reading = reading;

  // --- Selection time -------------------------------------------------------------------------
  lines.push("", "## Selection (dwell 1200 ms, snap 48 pt, grid of same-size targets, 8 s limit)");
  lines.push(
    "| head | target pt | pipeline | correct | wrong | timeouts | median time ms | p90 time ms | picker or magnifier shown |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  const selection: unknown[] = [];
  for (const motion of ["still", "natural"] as const) {
    const list = (subjects[`typical/${motion}`] ?? []).slice(0, Math.min(6, SEEDS));
    for (const size of [48, 96, 120, 160]) {
      const variants: [string, (s: Subject) => Pipeline & { engine?: never }, boolean][] = [
        ["v1", (s) => v1Pipeline(s.v1) as never, false],
        ["v2", (s) => v2Pipeline(s.v2) as never, false],
      ];
      variants.push(["v2 + helpers", (s) => v2Pipeline(s.v2) as never, true]);
      for (const [name, make, usePicker] of variants) {
        const agg: SelectionResult = { timesMs: [], correct: 0, wrong: 0, timeouts: 0, pickerUsed: 0 };
        for (const s of list) {
          const r = selectionTrials(s, () => make(s), size, 10, s.t + 400_000, usePicker);
          agg.timesMs.push(...r.timesMs);
          agg.correct += r.correct;
          agg.wrong += r.wrong;
          agg.timeouts += r.timeouts;
          agg.pickerUsed += r.pickerUsed;
        }
        const total = agg.correct + agg.wrong + agg.timeouts;
        const row = {
          motion,
          size,
          pipeline: name,
          trials: total,
          correctRate: agg.correct / total,
          wrongRate: agg.wrong / total,
          timeoutRate: agg.timeouts / total,
          medianMs: q(agg.timesMs, 0.5),
          p90Ms: q(agg.timesMs, 0.9),
          pickerShown: agg.pickerUsed,
        };
        selection.push(row);
        lines.push(
          `| ${motion} | ${size} | ${name} | ${fmt(row.correctRate * 100)}% | ${fmt(row.wrongRate * 100)}% | ${fmt(row.timeoutRate * 100)}% | ${fmt(row.medianMs)} | ${fmt(row.p90Ms)} | ${agg.pickerUsed} |`,
        );
      }
    }
  }
  results.selection = selection;

  // --- Continuous recalibration under drift ---------------------------------------------------
  lines.push(
    "",
    "## Continuous recalibration while the head slumps (3 cm down, 6 cm back, 6 deg over 2 min; 120 pt targets)",
  );
  lines.push(
    "| variant | error first 30 s pt | error after 3 min pt | correct | wrong | recalibration advised |",
  );
  lines.push("|---|---|---|---|---|---|");
  const drift: unknown[] = [];
  for (const continuous of [false, true]) {
    const runs = (subjects["typical/still"] ?? [])
      .slice(0, Math.min(6, SEEDS))
      .map((s) => driftRun(s, continuous));
    const row = {
      continuous,
      firstPt: mean(runs.map((r) => r.firstPt)),
      lastPt: mean(runs.map((r) => r.lastPt)),
      correct: runs.reduce((a, r) => a + r.correct, 0),
      wrong: runs.reduce((a, r) => a + r.wrong, 0),
      advised: runs.reduce((a, r) => a + r.advice, 0),
      subjects: runs.length,
    };
    drift.push(row);
    lines.push(
      `| ${continuous ? "v2 + continuous" : "v2 alone"} | ${fmt(row.firstPt)} | ${fmt(row.lastPt)} | ${row.correct} | ${row.wrong} | ${row.advised} of ${row.subjects} |`,
    );
  }
  results.drift = drift;

  results.calibrationComputeMs = {
    median: q(calTimes, 0.5),
    p90: q(calTimes, 0.9),
    note: "whole simulated calibration incl. rendering",
  };
  results.meta = {
    seeds: SEEDS,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ranAt: new Date().toISOString(),
    runtimeS: (performance.now() - t0) / 1000,
    simulated: true,
  };
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(join(here, "results", "pipeline.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(here, "results", "pipeline.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
});
