/**
 * The appearance model: RealEye's eye-image features (../eyeImage.ts) to the screen by ridge
 * regression, the way RealEye's own tracker maps them, fitted on the 5-second scan's frames and
 * blended with the landmark model (calibration v2).
 *
 * RealEye's model is always part of the estimate when the camera reads eye images. The person's
 * own scan decides the details, by cross-validation on stretches of the path held out in turn:
 * - The ridge strength, and whether to average a few frames before fitting (RealEye fixes 1e-5
 *   on single frames from 17 dots).
 * - Its share of the blend with the landmark model: 25 %, 50 %, 75 % or 100 %, whichever predicts
 *   held-out stretches best. Only if it measures far worse than the landmarks (1.5x: unusable eye
 *   crops, say) is it switched off, and the report says so.
 * The final fit adds RealEye's calibration augmentation: every training frame again with both eye
 * crops moved 1 px in each of the 8 directions (their AUGMENTATION_OFFSETS_1PX), so small slips of
 * the crop box, which follows noisy landmarks, matter less. The cross-validation above runs without
 * it (9x the frames in every fold would take too long); the check dots after the scan measure the
 * model as used, augmentation included.
 * It is solved in its dual form, one equation per frame instead of per feature, so 1,630 features
 * and up to 720 rows (frames x 9 copies; consecutive frames are averaged first when there are more)
 * fit in well under a second.
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

/** What the scan measured, for the person and for support: shown after the scan and in Settings. */
export interface AppearanceReport {
  /** Held-out error (points) of the face points (landmark model) alone. */
  landmarksPt: number;
  /** Held-out error of RealEye's eye-image model alone. */
  realEyePt: number;
  /** Held-out error of the estimate as used. */
  usedPt: number;
  /** RealEye's share of the estimate, 0..1 (0: its model is off). */
  realEyeWeight: number;
}

export interface AppearanceFit {
  /** Null when RealEye's model is off because it measured far worse than the face points. */
  calibration: AppearanceCalibration | null;
  report: AppearanceReport;
  /** usedPt / landmarksPt: scales the landmark model's own error estimate to the estimate used. */
  ratio: number;
  /** Held-out errors (points) by landmark weight, for tests. */
  errors: { landmarkWeight: number; errorPt: number }[];
}

type Point = { x: number; y: number };

/** Ridge strengths, as fractions of the mean squared feature norm. */
const RIDGE = [1e-4, 1e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1] as const;
const CHUNKS = [1, 3] as const;
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1] as const;
/** RealEye's model is switched off only if it alone measures this many times worse than the face points. */
const OFF_RATIO = 1.5;
/** Held-out predictions are averaged over this many frames before scoring, as the smoother would. */
const SCORE_CHUNK = 4;
/** RealEye's feature layout (eyeImage.ts): 30 landmark coordinates, then two 40x20 grey eye crops. */
const CROP_LANDMARKS = 30;
const CROP_W = 40;
const CROP_H = 20;
export const CROP_FEATURES = CROP_LANDMARKS + 2 * CROP_W * CROP_H;
/** RealEye's augmentation offsets besides the crop itself (AUGMENTATION_OFFSETS_1PX), [dx, dy] px. */
const SHIFTS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];
/** Most rows in the augmented final fit; above it, consecutive frames are averaged first. */
const MAX_ROWS = 720;

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

/**
 * The calibrated estimate: the landmark model's, blended with the appearance model when there is
 * one, plus the offset the check dots measured (check.ts) when there is one.
 */
export function predictBlend(
  landmarks: Point | null,
  appearance: AppearanceCalibration | null | undefined,
  eyes: Float32Array | null | undefined,
  offset?: Point | null,
): Point | null {
  const p = blend(landmarks, appearance, eyes);
  return p && offset ? { x: p.x + offset.x, y: p.y + offset.y } : p;
}

function blend(
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

/**
 * RealEye's features with both eye crops moved by (dx, dy) px, as their offset crop does (the crop
 * window moves, so the picture moves the other way), each crop then normalised to zero mean and
 * unit variance as theirs is. RealEye cuts the moved crop from a slightly larger picture; this
 * repeats the edge row or column instead, the one part of it the features don't hold.
 */
export function shiftCrops(eyes: Float32Array, dx: number, dy: number): Float32Array {
  const out = new Float32Array(eyes.length);
  out.set(eyes.subarray(0, CROP_LANDMARKS));
  const n = CROP_W * CROP_H;
  for (let e = 0; e < 2; e++) {
    const base = CROP_LANDMARKS + e * n;
    let sum = 0;
    for (let r = 0; r < CROP_H; r++) {
      const from = base + Math.min(CROP_H - 1, Math.max(0, r + dy)) * CROP_W;
      for (let c = 0; c < CROP_W; c++) {
        const v = eyes[from + Math.min(CROP_W - 1, Math.max(0, c + dx))]!;
        out[base + r * CROP_W + c] = v;
        sum += v;
      }
    }
    const m = sum / n;
    let sq = 0;
    for (let i = base; i < base + n; i++) sq += (out[i]! - m) ** 2;
    const sd = Math.max(Math.sqrt(sq / n), 1e-6);
    for (let i = base; i < base + n; i++) out[i] = (out[i]! - m) / sd;
  }
  return out;
}

function dotF(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** All dot products of `rows` with each other (m x m, row-major), four at a time for speed. */
function gramOf(rows: readonly Float32Array[]): Float64Array {
  const m = rows.length;
  const gram = new Float64Array(m * m);
  for (let a = 0; a < m; a++) {
    const x = rows[a]!;
    const d = x.length;
    let b = 0;
    for (; b + 3 <= a; b += 4) {
      const p = rows[b]!;
      const q = rows[b + 1]!;
      const r = rows[b + 2]!;
      const t = rows[b + 3]!;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let i = 0; i < d; i++) {
        const v = x[i]!;
        s0 += v * p[i]!;
        s1 += v * q[i]!;
        s2 += v * r[i]!;
        s3 += v * t[i]!;
      }
      gram[a * m + b] = gram[b * m + a] = s0;
      gram[a * m + b + 1] = gram[(b + 1) * m + a] = s1;
      gram[a * m + b + 2] = gram[(b + 2) * m + a] = s2;
      gram[a * m + b + 3] = gram[(b + 3) * m + a] = s3;
    }
    for (; b <= a; b++) gram[a * m + b] = gram[b * m + a] = dotF(x, rows[b]!);
  }
  return gram;
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

const excluded = (held: number, group: number) => group === held;

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
 * Fit the appearance model on the scan's frames and decide its share, next to the landmark model
 * `landmarks` (its configuration, refitted per fold on `landmarkData`). Null when there aren't
 * enough frames with eye images to fit or judge it.
 */
export function fitAppearance(
  frames: readonly AppearanceFrame[],
  landmarkData: readonly Sample[],
  landmarks: ModelConfig,
  options: { augment?: boolean } = {},
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
    const gram = gramOf(items.map((it) => it.eyes));
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
  const realEyeOnly = errors.find((e) => e.landmarkWeight === 0)!.errorPt;
  if (!Number.isFinite(landmarkOnly) || landmarkOnly <= 0) return null;
  if (!(realEyeOnly <= OFF_RATIO * landmarkOnly)) {
    return {
      calibration: null,
      report: { landmarksPt: landmarkOnly, realEyePt: realEyeOnly, usedPt: landmarkOnly, realEyeWeight: 0 },
      ratio: 1,
      errors,
    };
  }
  const top = errors.filter((e) => e.landmarkWeight < 1).reduce((a, b) => (b.errorPt < a.errorPt ? b : a));

  // Final fit on every frame, each again with its crops moved 1 px each way (RealEye's augmentation).
  const augment = (options.augment ?? true) && d === CROP_FEATURES;
  let chunk = chosen.chunk;
  let base = itemsFor(frames, chunk);
  while (augment && base.length * (SHIFTS.length + 1) > MAX_ROWS) base = itemsFor(frames, ++chunk);
  const items = augment
    ? base.flatMap((it) => [it, ...SHIFTS.map(([dx, dy]) => ({ ...it, eyes: shiftCrops(it.eyes, dx, dy) }))])
    : base;
  const m = items.length;
  const gram = gramOf(items.map((it) => it.eyes));
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
    report: {
      landmarksPt: landmarkOnly,
      realEyePt: realEyeOnly,
      usedPt: top.errorPt,
      realEyeWeight: 1 - top.landmarkWeight,
    },
    ratio: top.errorPt / landmarkOnly,
    errors,
  };
}
