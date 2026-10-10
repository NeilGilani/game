/** Small dense linear algebra for calibration: weighted ridge regression and helpers. */

/** Solve A x = b (Gaussian elimination with partial pivoting). Throws on a singular system. */
export function solve(a: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    if (Math.abs(p) < 1e-12) throw new Error("singular system");
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / p;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

export interface Standardiser {
  mean: number[];
  std: number[];
}

/** Weighted column means and standard deviations (std 1 for constant columns). */
export function standardiser(
  rows: readonly (readonly number[])[],
  weights?: readonly number[],
): Standardiser {
  const d = rows[0]?.length ?? 0;
  const w = weights ?? rows.map(() => 1);
  const total = w.reduce((s, x) => s + x, 0) || 1;
  const mean = Array.from({ length: d }, (_, j) => rows.reduce((s, r, i) => s + w[i]! * r[j]!, 0) / total);
  const std = Array.from({ length: d }, (_, j) => {
    const variance = rows.reduce((s, r, i) => s + w[i]! * (r[j]! - mean[j]!) ** 2, 0) / total;
    const sd = Math.sqrt(variance);
    return sd > 1e-9 ? sd : 1;
  });
  return { mean, std };
}

/** [1, standardised row...]: the design row with a bias term. */
export function designRow(row: readonly number[], s: Standardiser): number[] {
  const out = new Array<number>(row.length + 1);
  out[0] = 1;
  for (let j = 0; j < row.length; j++) out[j + 1] = (row[j]! - s.mean[j]!) / s.std[j]!;
  return out;
}

/**
 * Weighted ridge regression on design rows (first column is the bias, not regularised).
 * Minimises sum w_i (y_i - x_i.b)^2 + lambda * W * |b[1:]|^2, where W is the total weight, so
 * lambda means the same thing whatever the number of samples.
 */
export function ridge(
  x: readonly (readonly number[])[],
  y: readonly number[],
  lambda: number,
  weights?: readonly number[],
): number[] {
  const d = x[0]?.length ?? 0;
  const xtx = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const xty = new Array<number>(d).fill(0);
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    const row = x[i]!;
    const w = weights ? weights[i]! : 1;
    if (w <= 0) continue;
    total += w;
    for (let a = 0; a < d; a++) {
      const ra = row[a]! * w;
      xty[a]! += ra * y[i]!;
      for (let b = a; b < d; b++) xtx[a]![b]! += ra * row[b]!;
    }
  }
  for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) xtx[a]![b] = xtx[b]![a]!;
  for (let a = 1; a < d; a++) xtx[a]![a]! += lambda * Math.max(total, 1);
  return solve(xtx, xty);
}

export function dot(w: readonly number[], x: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i]! * x[i]!;
  return s;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median absolute deviation, scaled to match a standard deviation for normal data. */
export function mad(values: readonly number[]): number {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN;
}

/** 3-vector and 3x3 helpers (row-major 3x3). */
export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function mulMat3Vec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function transpose3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k]! * b[k * 3 + c]!;
      out[r * 3 + c] = s;
    }
  return out;
}

/** Rotation from yaw (about y), pitch (about x) and roll (about z), in radians: R = Ry * Rx * Rz. */
export function rotationYPR(yaw: number, pitch: number, roll: number): Mat3 {
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const cr = Math.cos(roll),
    sr = Math.sin(roll);
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rx: Mat3 = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const rz: Mat3 = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  return mulMat3(ry, mulMat3(rx, rz));
}

export const norm3 = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
export function unit3(v: Vec3): Vec3 {
  const n = norm3(v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Deterministic pseudo-random numbers (LCG), so tests and benchmarks are repeatable. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Standard normal from a uniform source (Box-Muller). */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
