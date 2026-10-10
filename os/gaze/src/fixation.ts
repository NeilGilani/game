/**
 * Fixation detection and fixation-aware smoothing.
 *
 * Webcam gaze is noisy frame to frame (often 100 to 200 points RMS), so a pointer that follows
 * every frame shakes, and a heavy low-pass filter lags behind real eye movements. Eyes don't
 * move smoothly anyway: they hold still (fixations, 150 to 600 ms) and jump (saccades, 20 to 80
 * ms). So the smoother does what the eye does:
 *
 * - During a fixation it outputs the trimmed mean of the fixation so far, which gets steadier the
 *   longer the person looks, with no lag because the eye isn't moving.
 * - A saccade is a statistical test, not a fixed radius: the mean of the last k samples is
 *   compared with the fixation centre, for k = 1..maxK, against
 *   max(minimum, z * noise * sqrt(1/k + 1/n)), where n is the number of samples in the centre.
 *   A big jump is caught on its first frame (k = 1); a small one once a few frames agree. The
 *   noise level is learned from the person's own fixations, so a steady tracker (mouse, external
 *   tracker) reacts to small moves and a noisy webcam doesn't jump at noise.
 * - On a saccade the output moves to the new place at once instead of sliding there.
 *
 * This is a dispersion test (I-DT family) run on several time scales; ivtLabels below is the
 * classic velocity test (I-VT), used by benchmarks for comparison.
 */

import { DEFAULT_GEOMETRY, type ViewingGeometry, degreesToPoints } from "./calibration/viewing";

export interface FixationOptions {
  /** Never call a move smaller than this (degrees) a saccade, however steady the signal. */
  minSaccadeDeg: number;
  /** z-score for the test (2D, several scales tested per frame), measured in tests/fixation.test.ts. */
  z: number;
  /** Longest run of recent samples tested (frames). */
  maxK: number;
  /** A fixation is reported once it has lasted this long (ms). */
  minFixationMs: number;
  /** Average over at most this much of the fixation (ms); longer looks follow slow drift. */
  windowMs: number;
  /** Starting guess for the 2D RMS noise of raw samples (points), refined from fixations. */
  initialNoisePt: number;
  /** Viewing distance used to convert degrees to points (updated from the iris size). */
  distanceCm: number;
  geometry: ViewingGeometry;
}

export const DEFAULT_FIXATION: FixationOptions = {
  minSaccadeDeg: 1,
  z: 3.3,
  maxK: 6,
  minFixationMs: 100,
  windowMs: 1000,
  initialNoisePt: 150,
  distanceCm: 60,
  geometry: DEFAULT_GEOMETRY,
};

export interface SmoothedPoint {
  x: number;
  y: number;
  /** True once the eyes have held on one place for minFixationMs. */
  fixation: boolean;
  /** How long the current fixation has lasted (ms). */
  fixationMs: number;
  /** Learned RMS noise of raw samples (points): live precision before smoothing. */
  noisePt: number;
  /** Expected error of the output from noise alone (noise / sqrt(samples averaged)), points. */
  outputNoisePt: number;
  /** True on the sample where a saccade was detected (the output jumped). */
  saccade: boolean;
}

interface P {
  t: number;
  x: number;
  y: number;
}

function trimmedMean(pts: readonly P[]): { x: number; y: number } {
  let mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  let my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  if (pts.length >= 6) {
    const sorted = [...pts].sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my));
    const kept = sorted.slice(0, Math.ceil(sorted.length * 0.8));
    mx = kept.reduce((s, p) => s + p.x, 0) / kept.length;
    my = kept.reduce((s, p) => s + p.y, 0) / kept.length;
  }
  return { x: mx, y: my };
}

export class FixationSmoother {
  private o: FixationOptions;
  private points: P[] = [];
  private startedAt = 0;
  private noise: number;
  private last: SmoothedPoint | null = null;

  constructor(options: Partial<FixationOptions> = {}) {
    this.o = { ...DEFAULT_FIXATION, ...options };
    this.noise = this.o.initialNoisePt;
  }

  setOptions(options: Partial<FixationOptions>): void {
    this.o = { ...this.o, ...options };
  }

  get minSaccadePt(): number {
    return degreesToPoints(this.o.minSaccadeDeg, this.o.distanceCm, this.o.geometry);
  }

  get noisePt(): number {
    return this.noise;
  }

  reset(): void {
    this.points = [];
    this.last = null;
  }

  /** Break the fixation (e.g. after tracking was lost) without forgetting the learned noise. */
  private learnNoise(): void {
    const pts = this.points;
    if (pts.length < 8) return;
    const c = trimmedMean(pts);
    const d = pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)).sort((a, b) => a - b);
    // Robust RMS: the median distance of a 2D Gaussian is 0.8326 * RMS.
    const rms = d[Math.floor(d.length / 2)]! / 0.8326;
    this.noise = Math.max(2, 0.8 * this.noise + 0.2 * rms);
  }

  update(t: number, x: number, y: number): SmoothedPoint {
    const p = { t, x, y };
    let saccade = false;
    this.points.push(p);
    if (this.points.length === 1) this.startedAt = t;
    const n = this.points.length;
    const minPt = this.minSaccadePt;
    for (let k = 1; k <= Math.min(this.o.maxK, n - 3); k++) {
      const base = this.points.slice(0, n - k);
      const recent = this.points.slice(n - k);
      const c = trimmedMean(base);
      const mx = recent.reduce((s, q) => s + q.x, 0) / k;
      const my = recent.reduce((s, q) => s + q.y, 0) / k;
      // Both means are uncertain: the recent k samples and the fixation centre (n - k samples).
      const threshold = Math.max(minPt, this.o.z * this.noise * Math.sqrt(1 / k + 1 / base.length));
      if (Math.hypot(mx - c.x, my - c.y) > threshold) {
        this.points = base;
        this.learnNoise();
        this.points = recent;
        this.startedAt = recent[0]!.t;
        saccade = true;
        break;
      }
    }
    if (!saccade) {
      const cutoff = t - this.o.windowMs;
      while (this.points.length > 4 && this.points[0]!.t < cutoff) this.points.shift();
      if (this.points.length >= 12 && this.points.length % 6 === 0) this.learnNoise();
    }
    const c = trimmedMean(this.points);
    const fixationMs = t - this.startedAt;
    const out: SmoothedPoint = {
      x: c.x,
      y: c.y,
      fixation: fixationMs >= this.o.minFixationMs,
      fixationMs,
      noisePt: this.noise,
      outputNoisePt: this.noise / Math.sqrt(this.points.length),
      saccade,
    };
    this.last = out;
    return out;
  }

  get current(): SmoothedPoint | null {
    return this.last;
  }
}

/** Classic I-VT labelling of a sample stream, for benchmarks and tests: true = fixation sample. */
export function ivtLabels(points: readonly P[], thresholdPtPerS: number): boolean[] {
  return points.map((p, i) => {
    if (i === 0) return true;
    const q = points[i - 1]!;
    const dt = Math.max(1, p.t - q.t) / 1000;
    return Math.hypot(p.x - q.x, p.y - q.y) / dt < thresholdPtPerS;
  });
}
