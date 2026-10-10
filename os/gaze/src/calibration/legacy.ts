/**
 * Calibration: learn a mapping from camera features to screen position from a few known
 * targets, and measure how well it generalises before trusting it for selection.
 *
 * Model: ridge regression per screen axis on standardised features. Two candidate feature
 * sets (linear and quadratic) are fitted and the one with lower leave-one-target-out error
 * is kept, so the quality number reflects how the model does on a target it never saw.
 */

import type { GazeFeatures } from "../landmarks";

export type FeatureSet = "gaze" | "head";
export type QualityGrade = "good" | "fair" | "poor";

export interface CalibrationTarget {
  /** Normalised viewport position, 0..1. */
  x: number;
  y: number;
}

export interface CalibrationSample {
  target: CalibrationTarget;
  features: number[];
}

export interface CalibrationQuality {
  /** Mean leave-one-target-out error, in normalised screen units (fraction of width/height). */
  meanError: number;
  maxError: number;
  perTarget: { target: CalibrationTarget; error: number; samples: number }[];
  grade: QualityGrade;
}

export interface CalibrationModel {
  version: 1;
  set: FeatureSet;
  basis: "linear" | "quadratic";
  mean: number[];
  std: number[];
  wx: number[];
  wy: number[];
  lambda: number;
  quality: CalibrationQuality;
  createdAt: string;
  viewport: { width: number; height: number };
}

export const GOOD_ERROR = 0.12;
export const FAIR_ERROR = 0.2;

export function gradeFor(meanError: number): QualityGrade {
  if (meanError < GOOD_ERROR) return "good";
  if (meanError < FAIR_ERROR) return "fair";
  return "poor";
}

/** Raw feature vector for a frame. */
export function featureVector(f: GazeFeatures, set: FeatureSet): number[] {
  if (set === "head") return [f.pose.yaw, f.pose.pitch, f.nose.x, f.nose.y];
  return [f.h, f.v, f.pose.yaw, f.pose.pitch];
}

function expand(raw: readonly number[], set: FeatureSet, basis: "linear" | "quadratic"): number[] {
  if (basis === "linear") return [...raw];
  if (set === "gaze") {
    const [h = 0, v = 0, ...rest] = raw;
    return [h, v, h * h, v * v, h * v, ...rest];
  }
  const [yaw = 0, pitch = 0, ...rest] = raw;
  return [yaw, pitch, yaw * yaw, pitch * pitch, yaw * pitch, ...rest];
}

/** Solve A x = b for small dense systems (Gaussian elimination with partial pivoting). */
export function solve(a: number[][], b: number[]): number[] {
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
      for (let c = col; c <= n; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

function standardise(rows: number[][]): { mean: number[]; std: number[] } {
  const d = rows[0]?.length ?? 0;
  const mean = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r[j]!, 0) / rows.length);
  const std = Array.from({ length: d }, (_, j) => {
    const variance = rows.reduce((s, r) => s + (r[j]! - mean[j]!) ** 2, 0) / rows.length;
    return Math.sqrt(variance) || 1;
  });
  return { mean, std };
}

function design(row: readonly number[], mean: readonly number[], std: readonly number[]): number[] {
  return [1, ...row.map((v, j) => (v - mean[j]!) / std[j]!)];
}

function ridge(x: number[][], y: number[], lambda: number): number[] {
  const d = x[0]!.length;
  const xtx = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const xty = new Array<number>(d).fill(0);
  for (let i = 0; i < x.length; i++) {
    const row = x[i]!;
    for (let a = 0; a < d; a++) {
      xty[a]! += row[a]! * y[i]!;
      for (let b = 0; b < d; b++) xtx[a]![b]! += row[a]! * row[b]!;
    }
  }
  for (let a = 1; a < d; a++) xtx[a]![a]! += lambda * x.length; // bias is not regularised
  return solve(xtx, xty);
}

const dotp = (w: readonly number[], x: readonly number[]): number =>
  w.reduce((s, wi, i) => s + wi * x[i]!, 0);

/** Remove samples far from their target's median (blinks, glances away). */
export function rejectOutliers(samples: CalibrationSample[], k = 3): CalibrationSample[] {
  const groups = new Map<string, CalibrationSample[]>();
  for (const s of samples) {
    const key = `${s.target.x},${s.target.y}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const kept: CalibrationSample[] = [];
  for (const group of groups.values()) {
    const d = group[0]!.features.length;
    const medians: number[] = [];
    const mads: number[] = [];
    for (let j = 0; j < d; j++) {
      const values = group.map((s) => s.features[j]!).sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)]!;
      const deviations = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
      medians.push(median);
      mads.push(deviations[Math.floor(deviations.length / 2)]! || 1e-9);
    }
    for (const s of group) {
      const ok = s.features.every(
        (v, j) => Math.abs(v - medians[j]!) <= k * 1.4826 * mads[j]! || group.length < 5,
      );
      if (ok) kept.push(s);
    }
  }
  return kept;
}

interface Fit {
  basis: "linear" | "quadratic";
  mean: number[];
  std: number[];
  wx: number[];
  wy: number[];
}

function fitBasis(
  samples: CalibrationSample[],
  set: FeatureSet,
  basis: "linear" | "quadratic",
  lambda: number,
): Fit {
  const rows = samples.map((s) => expand(s.features, set, basis));
  const { mean, std } = standardise(rows);
  const x = rows.map((r) => design(r, mean, std));
  return {
    basis,
    mean,
    std,
    wx: ridge(
      x,
      samples.map((s) => s.target.x),
      lambda,
    ),
    wy: ridge(
      x,
      samples.map((s) => s.target.y),
      lambda,
    ),
  };
}

function predictWith(fit: Fit, set: FeatureSet, features: readonly number[]): CalibrationTarget {
  const row = design(expand(features, set, fit.basis), fit.mean, fit.std);
  return { x: dotp(fit.wx, row), y: dotp(fit.wy, row) };
}

function targetKey(t: CalibrationTarget): string {
  return `${t.x.toFixed(4)},${t.y.toFixed(4)}`;
}

function leaveOneTargetOut(
  samples: CalibrationSample[],
  set: FeatureSet,
  basis: "linear" | "quadratic",
  lambda: number,
): CalibrationQuality {
  const targets = [...new Map(samples.map((s) => [targetKey(s.target), s.target])).values()];
  const perTarget: CalibrationQuality["perTarget"] = [];
  for (const target of targets) {
    const train = samples.filter((s) => targetKey(s.target) !== targetKey(target));
    const test = samples.filter((s) => targetKey(s.target) === targetKey(target));
    let error = 1;
    try {
      const fit = fitBasis(train, set, basis, lambda);
      const preds = test.map((s) => predictWith(fit, set, s.features));
      const px = preds.reduce((a, p) => a + p.x, 0) / preds.length;
      const py = preds.reduce((a, p) => a + p.y, 0) / preds.length;
      error = Math.hypot(px - target.x, py - target.y);
    } catch {
      error = 1;
    }
    perTarget.push({ target, error, samples: test.length });
  }
  const meanError = perTarget.reduce((s, p) => s + p.error, 0) / Math.max(perTarget.length, 1);
  const maxError = Math.max(...perTarget.map((p) => p.error), 0);
  return { meanError, maxError, perTarget, grade: gradeFor(meanError) };
}

export class CalibrationError extends Error {}

export function fitCalibration(
  input: CalibrationSample[],
  set: FeatureSet,
  viewport: { width: number; height: number },
  lambda = 0.01,
): CalibrationModel {
  const samples = rejectOutliers(input);
  const targets = new Set(samples.map((s) => targetKey(s.target)));
  if (targets.size < 5) {
    throw new CalibrationError("Not enough targets were captured. Please try calibration again.");
  }
  const candidates: ("linear" | "quadratic")[] = targets.size >= 9 ? ["linear", "quadratic"] : ["linear"];
  let best: { fit: Fit; quality: CalibrationQuality } | null = null;
  for (const basis of candidates) {
    const quality = leaveOneTargetOut(samples, set, basis, lambda);
    if (!best || quality.meanError < best.quality.meanError) {
      best = { fit: fitBasis(samples, set, basis, lambda), quality };
    }
  }
  const chosen = best!;
  return {
    version: 1,
    set,
    basis: chosen.fit.basis,
    mean: chosen.fit.mean,
    std: chosen.fit.std,
    wx: chosen.fit.wx,
    wy: chosen.fit.wy,
    lambda,
    quality: chosen.quality,
    createdAt: new Date().toISOString(),
    viewport,
  };
}

export function predict(model: CalibrationModel, features: readonly number[]): CalibrationTarget {
  const row = design(expand(features, model.set, model.basis), model.mean, model.std);
  return { x: dotp(model.wx, row), y: dotp(model.wy, row) };
}

/** 3x3 grid of targets at 10% / 50% / 90%, visited in a reading-order path. */
export function calibrationTargets(): CalibrationTarget[] {
  const stops = [0.1, 0.5, 0.9];
  const out: CalibrationTarget[] = [];
  for (const y of stops) for (const x of stops) out.push({ x, y });
  // Start at the centre so the first fixation is easy.
  const centre = out.splice(4, 1)[0]!;
  return [centre, ...out];
}

export function isCalibrationModel(value: unknown): value is CalibrationModel {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<CalibrationModel>;
  return (
    m.version === 1 &&
    (m.set === "gaze" || m.set === "head") &&
    Array.isArray(m.wx) &&
    Array.isArray(m.wy) &&
    Array.isArray(m.mean) &&
    Array.isArray(m.std) &&
    m.wx.length === m.wy.length &&
    m.mean.length === m.std.length &&
    m.wx.length === m.mean.length + 1
  );
}
