/**
 * Calibration v2: map GazeInputs to global screen points.
 *
 * Candidate models differ in which eye(s) they read (left, right, binocular average, or a fusion
 * of separate per-eye models), the polynomial degree (1 to 3), how the head is handled, and the
 * ridge strength. Head handling:
 * - "ray": only where the eye's ray meets the display (nominal eyeball model, head rotation and
 *   position from the facial transformation matrix). All eye signal flows through physics, so
 *   head movement is compensated even when the person held still during calibration (when the
 *   data alone can't teach the model what head movement does).
 * - "linear": eye terms plus head pose and position terms learned from the data.
 * - "geometric": both. All candidates are scored by leave-one-target-out cross-validation on the person's
 * own samples, so the chosen model is the one that best predicts a target it never saw, and the
 * reported error is that held-out error, not a training fit.
 */

import { type Standardiser, designRow, dot, mad, median, ridge, standardiser } from "../linalg";
import type { GazeInput } from "./features";

export type EyeChoice = "binocular" | "fused" | "left" | "right";
export type HeadTerms = "ray" | "linear" | "geometric";

export interface ModelConfig {
  eye: EyeChoice;
  degree: 1 | 2 | 3;
  head: HeadTerms;
  lambda: number;
}

export interface Sample {
  /** Target in global screen points. */
  x: number;
  y: number;
  input: GazeInput;
  /** 1 for calibration dots; less for samples learned from everyday selections. */
  weight?: number;
  /** Groups samples for cross-validation (one id per target presentation). */
  group: string;
}

interface Linear {
  s: Standardiser;
  wx: number[];
  wy: number[];
}

export interface FittedModel {
  version: 2;
  config: ModelConfig;
  /** One linear map, or two (left, right) for "fused". */
  parts: { eye: "binocular" | "left" | "right"; map: Linear }[];
}

export const LAMBDAS = [1e-3, 1e-2, 1e-1, 1] as const;
export const DEGREES = [1, 2, 3] as const;
export const EYES: readonly EyeChoice[] = ["fused", "binocular", "left", "right"];
export const HEADS: readonly HeadTerms[] = ["ray", "geometric", "linear"];

function poly(h: number, v: number, degree: number): number[] {
  const out = [h, v];
  if (degree >= 2) out.push(h * h, v * v, h * v);
  if (degree >= 3) out.push(h * h * h, v * v * v, h * h * v, h * v * v);
  return out;
}

type EyeData = { h: number; v: number; gx: number | null; gy: number | null };

function eyeData(input: GazeInput, eye: "binocular" | "left" | "right"): EyeData | null {
  if (eye === "left") return input.left;
  if (eye === "right") return input.right;
  const l = input.left;
  const r = input.right;
  if (l && r) {
    const geo = l.gx !== null && r.gx !== null && l.gy !== null && r.gy !== null;
    return {
      h: (l.h + r.h) / 2,
      v: (l.v + r.v) / 2,
      gx: geo ? (l.gx! + r.gx!) / 2 : null,
      gy: geo ? (l.gy! + r.gy!) / 2 : null,
    };
  }
  return l ?? r;
}

/** The regression row for one input, or null if the needed eye or geometry is missing. */
export function basis(
  input: GazeInput,
  eye: "binocular" | "left" | "right",
  degree: number,
  head: HeadTerms,
): number[] | null {
  const e = eyeData(input, eye);
  if (!e) return null;
  if (head === "ray") {
    if (e.gx === null || e.gy === null) return null;
    return poly(e.gx, e.gy, degree);
  }
  const row = poly(e.h, e.v, degree);
  row.push(input.yaw, input.pitch, input.roll, input.tx, input.ty, input.tz);
  if (degree >= 2) row.push(e.h * input.tz, e.v * input.tz);
  if (head === "geometric") {
    if (e.gx === null || e.gy === null) return null;
    row.push(e.gx, e.gy);
  }
  return row;
}

function partsFor(eye: EyeChoice): ("binocular" | "left" | "right")[] {
  return eye === "fused" ? ["left", "right"] : [eye];
}

function fitLinear(
  rows: number[][],
  xs: number[],
  ys: number[],
  weights: number[],
  lambda: number,
): Linear | null {
  if (rows.length < 3) return null;
  const s = standardiser(rows, weights);
  const design = rows.map((r) => designRow(r, s));
  try {
    return { s, wx: ridge(design, xs, lambda, weights), wy: ridge(design, ys, lambda, weights) };
  } catch {
    return null;
  }
}

export function fitModel(samples: readonly Sample[], config: ModelConfig): FittedModel | null {
  const parts: FittedModel["parts"] = [];
  for (const eye of partsFor(config.eye)) {
    const rows: number[][] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const ws: number[] = [];
    for (const s of samples) {
      const row = basis(s.input, eye, config.degree, config.head);
      if (!row) continue;
      rows.push(row);
      xs.push(s.x);
      ys.push(s.y);
      ws.push(s.weight ?? 1);
    }
    const map = fitLinear(rows, xs, ys, ws, config.lambda);
    if (map) parts.push({ eye, map });
  }
  if (parts.length === 0) return null;
  return { version: 2, config, parts };
}

/** Predicted global screen point, or null if no part of the model can read this input. */
export function predictModel(model: FittedModel, input: GazeInput): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const part of model.parts) {
    const row = basis(input, part.eye, model.config.degree, model.config.head);
    if (!row) continue;
    const d = designRow(row, part.map.s);
    sx += dot(part.map.wx, d);
    sy += dot(part.map.wy, d);
    n += 1;
  }
  if (n === 0 || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  return { x: sx / n, y: sy / n };
}

export interface CrossValidation {
  /** Mean error over held-out samples (each target held out in turn), in points. */
  meanErrorPt: number;
  /** Standard error of that mean across targets. */
  standardErrorPt: number;
  /** Per-target held-out error: distance between the mean prediction and the target. */
  perGroup: { group: string; x: number; y: number; errorPt: number; samples: number }[];
}

/** Leave-one-target-out cross-validation for one configuration. */
export function crossValidate(samples: readonly Sample[], config: ModelConfig): CrossValidation | null {
  const groups = [...new Set(samples.map((s) => s.group))];
  if (groups.length < 4) return null;
  const perGroup: CrossValidation["perGroup"] = [];
  const groupErrors: number[] = [];
  let total = 0;
  let count = 0;
  for (const g of groups) {
    const train = samples.filter((s) => s.group !== g);
    const test = samples.filter((s) => s.group === g && (s.weight ?? 1) > 0);
    if (test.length === 0) continue;
    const model = fitModel(train, config);
    if (!model) return null;
    let mx = 0;
    let my = 0;
    let n = 0;
    let groupTotal = 0;
    for (const s of test) {
      const p = predictModel(model, s.input);
      if (!p) continue;
      const e = Math.hypot(p.x - s.x, p.y - s.y);
      total += e;
      groupTotal += e;
      count += 1;
      mx += p.x;
      my += p.y;
      n += 1;
    }
    if (n === 0) return null;
    groupErrors.push(groupTotal / n);
    const t = test[0]!;
    perGroup.push({ group: g, x: t.x, y: t.y, errorPt: Math.hypot(mx / n - t.x, my / n - t.y), samples: n });
  }
  if (count === 0) return null;
  const errs = groupErrors;
  const m = errs.reduce((a, b) => a + b, 0) / errs.length;
  const sd = Math.sqrt(errs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, errs.length - 1));
  return { meanErrorPt: total / count, standardErrorPt: sd / Math.sqrt(errs.length), perGroup };
}

/** Lower is simpler: fewer eye terms, then no geometric terms, then one map, then more shrinkage. */
function complexity(c: ModelConfig): number {
  return (
    c.degree * 1000 + (c.head === "geometric" ? 100 : 0) + (c.eye === "fused" ? 10 : 0) - Math.log10(c.lambda)
  );
}

export interface Selection {
  model: FittedModel;
  cv: CrossValidation;
  /** Every configuration tried, best first (for reports and benchmarks). */
  tried: { config: ModelConfig; meanErrorPt: number }[];
}

export interface SelectOptions {
  eyes?: readonly EyeChoice[];
  degrees?: readonly (1 | 2 | 3)[];
  heads?: readonly HeadTerms[];
  lambdas?: readonly number[];
  /** Cap samples per target during the search (speed); the final fit uses all of them. */
  maxPerGroup?: number;
}

function thin(samples: readonly Sample[], maxPerGroup: number): Sample[] {
  const byGroup = new Map<string, Sample[]>();
  for (const s of samples) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  const out: Sample[] = [];
  for (const list of byGroup.values()) {
    const step = Math.max(1, list.length / maxPerGroup);
    for (let i = 0; i < list.length; i += step) out.push(list[Math.floor(i)]!);
  }
  return out;
}

/** Choose the configuration with the lowest cross-validated error and fit it on all samples. */
export function selectModel(samples: readonly Sample[], options: SelectOptions = {}): Selection | null {
  const search = thin(samples, options.maxPerGroup ?? 12);
  const tried: Selection["tried"] = [];
  let best: { config: ModelConfig; cv: CrossValidation } | null = null;
  const results: { config: ModelConfig; cv: CrossValidation }[] = [];
  for (const head of options.heads ?? HEADS) {
    for (const eye of options.eyes ?? EYES) {
      for (const degree of options.degrees ?? DEGREES) {
        for (const lambda of options.lambdas ?? LAMBDAS) {
          const config: ModelConfig = { eye, degree, head, lambda };
          const cv = crossValidate(search, config);
          if (!cv) continue;
          tried.push({ config, meanErrorPt: cv.meanErrorPt });
          results.push({ config, cv });
          if (!best || cv.meanErrorPt < best.cv.meanErrorPt) best = { config, cv };
        }
      }
    }
  }
  if (!best) return null;
  // One-standard-error rule: the simplest model whose error is within one standard error of the
  // best. With 9 to 16 targets the differences between close candidates are mostly noise.
  const limit = best.cv.meanErrorPt + best.cv.standardErrorPt;
  const simplest = results
    .filter((r) => r.cv.meanErrorPt <= limit)
    .sort((a, b) => complexity(a.config) - complexity(b.config))[0];
  if (simplest) best = simplest;
  const model = fitModel(samples, best.config);
  if (!model) return null;
  tried.sort((a, b) => a.meanErrorPt - b.meanErrorPt);
  return { model, cv: best.cv, tried };
}

function avg(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function averageEyes(eyes: readonly (GazeInput["left"] | null)[]): GazeInput["left"] {
  const present = eyes.filter((e) => e !== null);
  if (present.length === 0) return null;
  const geo = present.filter((e) => e.gx !== null && e.gy !== null);
  return {
    h: avg(present.map((e) => e.h)),
    v: avg(present.map((e) => e.v)),
    gx: geo.length ? avg(geo.map((e) => e.gx!)) : null,
    gy: geo.length ? avg(geo.map((e) => e.gy!)) : null,
  };
}

/** Mean of several inputs (same person, same target, a fraction of a second apart). */
export function averageInputs(inputs: readonly GazeInput[]): GazeInput {
  return {
    left: averageEyes(inputs.map((i) => i.left)),
    right: averageEyes(inputs.map((i) => i.right)),
    yaw: avg(inputs.map((i) => i.yaw)),
    pitch: avg(inputs.map((i) => i.pitch)),
    roll: avg(inputs.map((i) => i.roll)),
    tx: avg(inputs.map((i) => i.tx)),
    ty: avg(inputs.map((i) => i.ty)),
    tz: avg(inputs.map((i) => i.tz)),
    normalized: inputs.every((i) => i.normalized),
    irisDiameter: avg(inputs.map((i) => i.irisDiameter)),
  };
}

/**
 * Average consecutive frames of each target in chunks before fitting. Webcam iris features are
 * noisy frame to frame; regressing on noisy inputs shrinks the fitted map towards the screen
 * centre ("regression dilution"), which shows up as large errors near the edges. Chunk means
 * keep the inputs' signal (and slow head movement) while cutting that noise by about the square
 * root of the chunk size. Predictions are still made per frame and smoothed afterwards.
 */
export function aggregate(samples: readonly Sample[], chunk = 8): Sample[] {
  const byGroup = new Map<string, Sample[]>();
  for (const s of samples) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  const out: Sample[] = [];
  for (const list of byGroup.values()) {
    const n = Math.max(1, Math.round(list.length / Math.max(1, Math.round(list.length / chunk))));
    for (let i = 0; i < list.length; i += n) {
      const part = list.slice(i, i + n);
      out.push({
        x: avg(part.map((s) => s.x)),
        y: avg(part.map((s) => s.y)),
        input: averageInputs(part.map((s) => s.input)),
        weight: part.reduce((s, p) => s + (p.weight ?? 1), 0) / part.length,
        group: part[0]!.group,
      });
    }
  }
  return out;
}

/**
 * Outlier rejection in two passes. First, per target, drop frames whose eye features sit far
 * from that target's median (a blink, a glance away). Then fit, and drop frames whose residual
 * is far beyond the typical residual.
 */
export function rejectOutliers(samples: readonly Sample[], k = 3.5): Sample[] {
  const byGroup = new Map<string, Sample[]>();
  for (const s of samples) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  const kept: Sample[] = [];
  for (const list of byGroup.values()) {
    if (list.length < 5) {
      kept.push(...list);
      continue;
    }
    const value = (s: Sample, key: "h" | "v") => {
      const e = eyeData(s.input, "binocular");
      return e ? e[key] : NaN;
    };
    const stats = (["h", "v"] as const).map((key) => {
      const vals = list.map((s) => value(s, key)).filter(Number.isFinite);
      return { key, med: median(vals), spread: Math.max(mad(vals), 1e-4) };
    });
    for (const s of list) {
      const ok = stats.every(({ key, med, spread }) => Math.abs(value(s, key) - med) <= k * spread);
      if (ok) kept.push(s);
    }
  }
  return kept;
}

export function rejectResidualOutliers(samples: readonly Sample[], model: FittedModel, k = 3.5): Sample[] {
  const residuals = samples.map((s) => {
    const p = predictModel(model, s.input);
    return p ? Math.hypot(p.x - s.x, p.y - s.y) : Infinity;
  });
  const finite = residuals.filter(Number.isFinite);
  const limit = median(finite) + k * Math.max(mad(finite), 5);
  return samples.filter((_, i) => residuals[i]! <= limit);
}
