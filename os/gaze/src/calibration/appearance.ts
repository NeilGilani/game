/**
 * The appearance model: RealEye's eye-image features (../eyeImage.ts) to the screen by ridge
 * regression, the way RealEye's own tracker maps them, fitted on the 5-second scan's frames and
 * blended with the landmark model (calibration v2).
 *
 * Where it differs from RealEye's calibration, the person's own data decides:
 * - The ridge strength, and whether to average a few frames before fitting, are chosen by
 *   cross-validation (RealEye fixes 1e-5 on single frames from 17 dots).
 * - It is solved in its dual form, one equation per frame instead of per feature, so 1,630
 *   features and ~150 frames fit in milliseconds.
 * - Cross-validation holds out each stretch of the path together with its neighbours, so a model
 *   that only remembers what the eyes looked like a moment earlier can't score well.
 * - The blend weight is the one that best predicts held-out stretches. The eye images are used
 *   only if they beat the landmark model alone by at least 3 %; otherwise nothing changes.
 *
 * Tests: tests/appearance.test.ts.
 */

import type { GazeInput } from "./features";
import { type ModelConfig, type Sample, fitModel, predictModel } from "./model";

/**
 * screen = w . features + b. Only the weights are kept, not the training frames or their mean,
 * so no picture of the eyes is stored, just how each feature moves the estimate.
 */
export interface AppearanceModel {
  version: 1;
  wx: number[];
  wy: number[];
  bx: number;
  by: number;
}

export interface AppearanceCalibration {
  model: AppearanceModel;
  /** Weight of the landmark model in the blend, 0..1; the appearance model gets the rest. */
  landmarkWeight: number;
}

export interface AppearanceFrame {
  /** Where the light was (screen points). */
  x: number;
  y: number;
  eyes: Float32Array;
  input: GazeInput;
  /** Stretch of the path, numbered in path order (cross-validation groups). */
  group: number;
}

export interface AppearanceFit {
  calibration: AppearanceCalibration;
  /** Held-out error of the blend over the landmark model alone, measured the same way (< 1). */
  ratio: number;
  /** Held-out errors (points) by landmark weight, for reports and tests. */
  errors: { landmarkWeight: number; errorPt: number }[];
}

type Point = { x: number; y: number };

/** Ridge strengths, as fractions of the mean squared feature norm. */
const RIDGE = [1e-4, 1e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1] as const;
const CHUNKS = [1, 3] as const;
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1] as const;
const MIN_GAIN = 0.03;
/** Held-out predictions are averaged over this many frames before scoring, as the smoother would. */
const SCORE_CHUNK = 4;

export function predictAppearance(model: AppearanceModel, eyes: Float32Array): Point | null {
  const d = model.wx.length;
  if (eyes.length !== d || model.wy.length !== d) return null;
  let sx = model.bx;
  let sy = model.by;
  for (let i = 0; i < d; i++) {
    sx += model.wx[i]! * eyes[i]!;
    sy += model.wy[i]! * eyes[i]!;
  }
  return Number.isFinite(sx) && Number.isFinite(sy) ? { x: sx, y: sy } : null;
}

/** The calibrated estimate: the landmark model's, blended with the appearance model when there is one. */
export function predictBlend(
  landmarks: Point | null,
  appearance: AppearanceCalibration | null | undefined,
  eyes: Float32Array | null | undefined,
): Point | null {
  if (!appearance || !eyes) return landmarks;
  const a = predictAppearance(appearance.model, eyes);
  if (!a) return landmarks;
  if (!landmarks) return a;
  const w = appearance.landmarkWeight;
  return { x: w * landmarks.x + (1 - w) * a.x, y: w * landmarks.y + (1 - w) * a.y };
}

function dotF(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Lower-triangular Cholesky factor of an n x n SPD matrix (row-major), or null if not SPD. */
function cholesky(a: Float64Array, n: number): Float64Array | null {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * n + j]!;
      for (let k = 0; k < j; k++) s -= l[i * n + k]! * l[j * n + k]!;
      if (i === j) {
        if (!(s > 0)) return null;
        l[i * n + i] = Math.sqrt(s);
      } else {
        l[i * n + j] = s / l[j * n + j]!;
      }
    }
  }
  return l;
}

function cholSolve(l: Float64Array, n: number, b: readonly number[]): Float64Array {
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= l[i * n + k]! * z[k]!;
    z[i] = s / l[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i]!;
    for (let k = i + 1; k < n; k++) s -= l[k * n + i]! * x[k]!;
    x[i] = s / l[i * n + i]!;
  }
  return x;
}

interface Item {
  eyes: Float32Array;
  x: number;
  y: number;
  group: number;
}

/** Consecutive frames of each stretch averaged in chunks of `chunk` (training items). */
function itemsFor(frames: readonly AppearanceFrame[], chunk: number): Item[] {
  if (chunk === 1) return frames.map((f) => ({ eyes: f.eyes, x: f.x, y: f.y, group: f.group }));
  const out: Item[] = [];
  for (const list of byGroup(frames).values()) {
    for (let i = 0; i < list.length; i += chunk) {
      const part = list.slice(i, i + chunk);
      const eyes = new Float32Array(part[0]!.eyes.length);
      for (const f of part) for (let k = 0; k < eyes.length; k++) eyes[k]! += f.eyes[k]! / part.length;
      out.push({
        eyes,
        x: part.reduce((s, f) => s + f.x, 0) / part.length,
        y: part.reduce((s, f) => s + f.y, 0) / part.length,
        group: part[0]!.group,
      });
    }
  }
  return out;
}

function byGroup<T extends { group: number }>(list: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const f of list) out.set(f.group, [...(out.get(f.group) ?? []), f]);
  return out;
}

const excluded = (held: number, group: number) => Math.abs(group - held) <= 1;

/**
 * Kernel ridge on training items `train` (indices into items), with the kernel centred on the
 * training mean. Returns the dual weights for x and y per ridge strength, plus what's needed to
 * predict: the training means of the kernel rows and targets.
 */
function solveDual(
  gram: Float64Array,
  m: number,
  train: readonly number[],
  items: readonly Item[],
  ridges: readonly number[],
): {
  rowMean: Float64Array;
  c: number;
  mx: number;
  my: number;
  alphas: { ax: Float64Array; ay: Float64Array }[];
} | null {
  const n = train.length;
  const rowMean = new Float64Array(m);
  for (let a = 0; a < m; a++) {
    let s = 0;
    for (const b of train) s += gram[a * m + b]!;
    rowMean[a] = s / n;
  }
  let c = 0;
  for (const a of train) c += rowMean[a]!;
  c /= n;
  const k = new Float64Array(n * n);
  let trace = 0;
  for (let i = 0; i < n; i++) {
    const a = train[i]!;
    for (let j = 0; j < n; j++) {
      const b = train[j]!;
      k[i * n + j] = gram[a * m + b]! - rowMean[a]! - rowMean[b]! + c;
    }
    trace += k[i * n + i]!;
  }
  const scale = Math.max(trace / n, 1e-9);
  const mx = train.reduce((s, a) => s + items[a]!.x, 0) / n;
  const my = train.reduce((s, a) => s + items[a]!.y, 0) / n;
  const yx = train.map((a) => items[a]!.x - mx);
  const yy = train.map((a) => items[a]!.y - my);
  const alphas: { ax: Float64Array; ay: Float64Array }[] = [];
  for (const r of ridges) {
    const reg = k.slice();
    for (let i = 0; i < n; i++) reg[i * n + i]! += r * scale;
    const l = cholesky(reg, n);
    if (!l) return null;
    alphas.push({ ax: cholSolve(l, n, yx), ay: cholSolve(l, n, yy) });
  }
  return { rowMean, c, mx, my, alphas };
}

/** Mean error of held-out predictions after averaging SCORE_CHUNK consecutive frames per stretch. */
function heldOutError(frames: readonly AppearanceFrame[], preds: readonly (Point | null)[]): number {
  const indexed = frames.map((f, i) => ({ f, p: preds[i] ?? null, group: f.group }));
  let total = 0;
  let count = 0;
  for (const list of byGroup(indexed).values()) {
    for (let i = 0; i < list.length; i += SCORE_CHUNK) {
      const part = list.slice(i, i + SCORE_CHUNK).filter((e) => e.p);
      if (part.length === 0) continue;
      const px = part.reduce((s, e) => s + e.p!.x, 0) / part.length;
      const py = part.reduce((s, e) => s + e.p!.y, 0) / part.length;
      const tx = part.reduce((s, e) => s + e.f.x, 0) / part.length;
      const ty = part.reduce((s, e) => s + e.f.y, 0) / part.length;
      total += Math.hypot(px - tx, py - ty);
      count += 1;
    }
  }
  return count ? total / count : Infinity;
}

/**
 * Fit the appearance model on the scan's frames and decide how much to trust it, next to the
 * landmark model `landmarks` (its configuration, refitted per fold on `landmarkData`). Null when
 * the eye images don't help, or there isn't enough to judge.
 */
export function fitAppearance(
  frames: readonly AppearanceFrame[],
  landmarkData: readonly Sample[],
  landmarks: ModelConfig,
): AppearanceFit | null {
  const groups = [...new Set(frames.map((f) => f.group))].sort((a, b) => a - b);
  if (frames.length < 40 || groups.length < 6) return null;
  const d = frames[0]!.eyes.length;
  if (frames.some((f) => f.eyes.length !== d)) return null;

  // Held-out landmark-model predictions, with the same folds.
  const groupOf = (s: Sample) => Number(s.group.replace(/^\D+/, ""));
  const landmarkPreds: (Point | null)[] = frames.map(() => null);
  for (const g of groups) {
    const model = fitModel(
      landmarkData.filter((s) => !excluded(g, groupOf(s))),
      landmarks,
    );
    if (!model) continue;
    frames.forEach((f, i) => {
      if (f.group === g) landmarkPreds[i] = predictModel(model, f.input);
    });
  }

  // Held-out appearance predictions for every chunk size and ridge strength.
  let best: { chunk: number; ridge: number; error: number; preds: (Point | null)[] } | null = null;
  for (const chunk of CHUNKS) {
    const items = itemsFor(frames, chunk);
    const m = items.length;
    const gram = new Float64Array(m * m);
    for (let a = 0; a < m; a++) {
      for (let b = 0; b <= a; b++) {
        const v = dotF(items[a]!.eyes, items[b]!.eyes);
        gram[a * m + b] = v;
        gram[b * m + a] = v;
      }
    }
    const cross = frames.map((f) => items.map((it) => dotF(f.eyes, it.eyes)));
    const preds = RIDGE.map(() => frames.map((): Point | null => null));
    for (const g of groups) {
      const train = items.flatMap((it, a) => (excluded(g, it.group) ? [] : [a]));
      if (train.length < 10) continue;
      const solved = solveDual(gram, m, train, items, RIDGE);
      if (!solved) continue;
      frames.forEach((f, i) => {
        if (f.group !== g) return;
        const row = cross[i]!;
        let mean = 0;
        for (const b of train) mean += row[b]!;
        mean /= train.length;
        solved.alphas.forEach(({ ax, ay }, r) => {
          let px = solved.mx;
          let py = solved.my;
          train.forEach((b, j) => {
            const kv = row[b]! - mean - solved.rowMean[b]! + solved.c;
            px += ax[j]! * kv;
            py += ay[j]! * kv;
          });
          preds[r]![i] = { x: px, y: py };
        });
      });
    }
    RIDGE.forEach((ridge, r) => {
      const error = heldOutError(frames, preds[r]!);
      if (!best || error < best.error) best = { chunk, ridge, error, preds: preds[r]! };
    });
  }
  if (!best) return null;
  const chosen: { chunk: number; ridge: number; preds: (Point | null)[] } = best;

  // The blend weight that predicts held-out stretches best, on frames both models predicted.
  const both = frames.flatMap((_, i) => (landmarkPreds[i] && chosen.preds[i] ? [i] : []));
  if (both.length < 40) return null;
  const subset = both.map((i) => frames[i]!);
  const errors = WEIGHTS.map((w) => ({
    landmarkWeight: w,
    errorPt: heldOutError(
      subset,
      both.map((i) => {
        const l = landmarkPreds[i]!;
        const a = chosen.preds[i]!;
        return { x: w * l.x + (1 - w) * a.x, y: w * l.y + (1 - w) * a.y };
      }),
    ),
  }));
  const landmarkOnly = errors.find((e) => e.landmarkWeight === 1)!.errorPt;
  const top = errors.reduce((a, b) => (b.errorPt < a.errorPt ? b : a));
  if (top.landmarkWeight === 1 || !(top.errorPt <= (1 - MIN_GAIN) * landmarkOnly)) return null;

  // Final fit on every frame.
  const items = itemsFor(frames, chosen.chunk);
  const m = items.length;
  const gram = new Float64Array(m * m);
  for (let a = 0; a < m; a++) {
    for (let b = 0; b <= a; b++) {
      const v = dotF(items[a]!.eyes, items[b]!.eyes);
      gram[a * m + b] = v;
      gram[b * m + a] = v;
    }
  }
  const all = items.map((_, a) => a);
  const solved = solveDual(gram, m, all, items, [chosen.ridge]);
  if (!solved) return null;
  const { ax, ay } = solved.alphas[0]!;
  const mean = new Array<number>(d).fill(0);
  for (const it of items) for (let k = 0; k < d; k++) mean[k]! += it.eyes[k]! / m;
  const wx = new Array<number>(d).fill(0);
  const wy = new Array<number>(d).fill(0);
  items.forEach((it, a) => {
    for (let k = 0; k < d; k++) {
      const v = it.eyes[k]! - mean[k]!;
      wx[k]! += ax[a]! * v;
      wy[k]! += ay[a]! * v;
    }
  });
  // w . (x - mean) + b, with the mean folded into b.
  let bx = solved.mx;
  let by = solved.my;
  for (let k = 0; k < d; k++) {
    bx -= wx[k]! * mean[k]!;
    by -= wy[k]! * mean[k]!;
  }
  return {
    calibration: {
      model: { version: 1, wx, wy, bx, by },
      landmarkWeight: top.landmarkWeight,
    },
    ratio: top.errorPt / landmarkOnly,
    errors,
  };
}
