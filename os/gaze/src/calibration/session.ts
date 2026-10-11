/**
 * A calibration run: 9 to 16 adaptive training points, then a validation pass on held-out
 * targets the model never trained on. The reported quality is the validation error, in points
 * and (when the viewing distance can be estimated) degrees of visual angle.
 *
 * The session is pure logic: the host shows each target, waits for the eyes to settle, collects
 * GazeInputs for about a second (skipping blinks and low-confidence frames) and hands them in.
 * Nothing here has a time limit: the person can rest between targets for as long as they need.
 */

import type { AppearanceCalibration, AppearanceReport } from "./appearance";
import type { CalibrationQuality } from "../contracts";
import { mean } from "../linalg";
import type { GazeInput } from "./features";
import {
  type CrossValidation,
  type FittedModel,
  type Sample,
  type SelectOptions,
  aggregate,
  predictModel,
  rejectOutliers,
  rejectResidualOutliers,
  selectModel,
} from "./model";
import {
  DEFAULT_GEOMETRY,
  type ViewingGeometry,
  gradeForPoints,
  pointsToDegrees,
  viewingDistanceCm,
} from "./viewing";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionTarget {
  id: string;
  /** Global screen points. */
  x: number;
  y: number;
  phase: "train" | "validate";
  /** 1-based position and the current total, for "Dot 3 of 9". */
  index: number;
  total: number;
}

export interface SessionOptions {
  /** The display being calibrated, in global screen points. */
  display: Bounds;
  minPoints?: number;
  maxPoints?: number;
  validationPoints?: number;
  /** Frames needed for a target to count; fewer and it is shown once more. */
  minSamplesPerTarget?: number;
  geometry?: ViewingGeometry;
  search?: SelectOptions;
}

export interface ValidationResult {
  x: number;
  y: number;
  /** Distance from the mean estimate to the target (accuracy). */
  errorPt: number;
  /** RMS distance of individual estimates from their mean (precision). */
  precisionPt: number;
  samples: number;
}

export interface CalibrationResult {
  model: FittedModel;
  quality: CalibrationQuality;
  /** Cross-validated error on the training targets. */
  cvErrorPt: number;
  /** RMS precision on the validation targets, before smoothing. */
  precisionPt: number;
  distanceCm: number | null;
  validation: ValidationResult[];
  trainingTargets: number;
  samples: Sample[];
  geometry: ViewingGeometry;
  /** RealEye's eye-image model and its blend weight (appearance.ts); null when it's off. */
  appearance?: AppearanceCalibration | null;
  /** What the scan measured for RealEye's model; null when the camera gave no eye images. */
  realEye?: AppearanceReport | null;
}

export type SessionStep =
  | { kind: "target"; target: SessionTarget }
  | { kind: "done"; result: CalibrationResult }
  | { kind: "failed"; reason: string };

const GRID = [0.1, 0.5, 0.9];
/** Candidates for extra training points: the 4x4 interior grid and the edge midpoints. */
const EXTRA = [
  [0.3, 0.3],
  [0.7, 0.3],
  [0.3, 0.7],
  [0.7, 0.7],
  [0.5, 0.1],
  [0.1, 0.5],
  [0.9, 0.5],
  [0.5, 0.9],
  [0.3, 0.1],
  [0.7, 0.9],
  [0.1, 0.3],
  [0.9, 0.7],
  [0.7, 0.1],
  [0.3, 0.9],
  [0.9, 0.3],
  [0.1, 0.7],
] as const;
/**
 * Held-out validation positions, never used for training. Spread towards the edges (where
 * webcam error is largest) so the reported quality doesn't flatter the model.
 */
const VALIDATION = [
  [0.3, 0.17],
  [0.83, 0.3],
  [0.17, 0.7],
  [0.7, 0.83],
  [0.5, 0.4],
  [0.4, 0.6],
] as const;

export class CalibrationSession {
  private readonly o: Required<Omit<SessionOptions, "search">> & { search: SelectOptions };
  private queue: { id: string; nx: number; ny: number; phase: "train" | "validate" }[] = [];
  private collected = new Map<string, GazeInput[]>();
  private retried = new Set<string>();
  private trained: { id: string; nx: number; ny: number }[] = [];
  private usedExtras = new Set<string>();
  private selection: { model: FittedModel; cv: CrossValidation } | null = null;
  private trainingSamples: Sample[] = [];
  private validationStarted = false;
  private shown = 0;
  private finished: SessionStep | null = null;

  constructor(options: SessionOptions) {
    this.o = {
      minPoints: 9,
      maxPoints: 16,
      validationPoints: 4,
      minSamplesPerTarget: 8,
      geometry: DEFAULT_GEOMETRY,
      search: {},
      ...options,
    };
    this.o.minPoints = Math.max(9, Math.min(this.o.minPoints, 16));
    this.o.maxPoints = Math.max(this.o.minPoints, Math.min(this.o.maxPoints, 16));
    this.o.validationPoints = Math.max(2, Math.min(this.o.validationPoints, VALIDATION.length));
    const grid: { nx: number; ny: number }[] = [];
    for (const ny of GRID) for (const nx of GRID) grid.push({ nx, ny });
    // Start at the centre so the first fixation is easy, then reading order.
    const centre = grid.splice(4, 1)[0]!;
    for (const p of [centre, ...grid]) this.queue.push({ id: `t${p.nx},${p.ny}`, ...p, phase: "train" });
    const extras = EXTRA.slice(0, this.o.minPoints - 9);
    for (const [nx, ny] of extras) {
      this.usedExtras.add(`${nx},${ny}`);
      this.queue.push({ id: `t${nx},${ny}`, nx, ny, phase: "train" });
    }
  }

  private toGlobal(nx: number, ny: number): { x: number; y: number } {
    const d = this.o.display;
    return { x: d.x + nx * d.width, y: d.y + ny * d.height };
  }

  private plannedTotal(): number {
    const remainingTrain = this.queue.filter((q) => q.phase === "train").length;
    const validation = this.validationStarted ? 0 : this.o.validationPoints;
    return this.shown + remainingTrain + validation + this.queue.filter((q) => q.phase === "validate").length;
  }

  /** What to show next. Call after each addSamples (or at the start). */
  next(): SessionStep {
    if (this.finished) return this.finished;
    if (this.queue.length === 0) this.advance();
    if (this.finished) return this.finished;
    const q = this.queue[0]!;
    const p = this.toGlobal(q.nx, q.ny);
    return {
      kind: "target",
      target: { id: q.id, x: p.x, y: p.y, phase: q.phase, index: this.shown + 1, total: this.plannedTotal() },
    };
  }

  /** Hand in the frames collected while the person looked at `targetId`. */
  addSamples(targetId: string, inputs: readonly GazeInput[]): void {
    const i = this.queue.findIndex((q) => q.id === targetId);
    if (i < 0) return;
    const [q] = this.queue.splice(i, 1);
    this.shown += 1;
    if (inputs.length < this.o.minSamplesPerTarget && !this.retried.has(q!.id)) {
      // Too few usable frames (blinks, looked away): show it again once, at the end of this phase.
      this.retried.add(q!.id);
      const lastSamePhase = this.queue.map((x) => x.phase).lastIndexOf(q!.phase);
      this.queue.splice(lastSamePhase + 1, 0, q!);
      return;
    }
    this.collected.set(q!.id, [...(this.collected.get(q!.id) ?? []), ...inputs]);
    if (q!.phase === "train" && inputs.length > 0) this.trained.push({ id: q!.id, nx: q!.nx, ny: q!.ny });
  }

  /** Skip the remaining targets of this phase (for a person who is tired); quality reflects it. */
  skipRemaining(): void {
    const phase = this.queue[0]?.phase;
    this.queue = this.queue.filter((q) => q.phase !== phase);
  }

  private samplesFor(points: { id: string; nx: number; ny: number }[]): Sample[] {
    const out: Sample[] = [];
    for (const p of points) {
      const g = this.toGlobal(p.nx, p.ny);
      for (const input of this.collected.get(p.id) ?? []) out.push({ x: g.x, y: g.y, input, group: p.id });
    }
    return out;
  }

  private fit(): boolean {
    const frames = rejectOutliers(this.samplesFor(this.trained));
    const groups = new Set(frames.map((s) => s.group));
    if (groups.size < 5) return false;
    let samples = aggregate(frames);
    let selection = selectModel(samples, this.o.search);
    if (!selection) return false;
    const cleaned = rejectResidualOutliers(samples, selection.model);
    if (cleaned.length < samples.length && new Set(cleaned.map((s) => s.group)).size === groups.size) {
      const again = selectModel(cleaned, this.o.search);
      if (again) {
        selection = again;
        samples = cleaned;
      }
    }
    this.selection = selection;
    this.trainingSamples = samples;
    return true;
  }

  private advance(): void {
    if (!this.validationStarted) {
      if (!this.fit()) {
        this.finished = {
          kind: "failed",
          reason: "Not enough dots were seen clearly. Rest for a moment, then try calibration again.",
        };
        return;
      }
      const cv = this.selection!.cv;
      const room = this.o.maxPoints - this.trained.length;
      if (gradeForPoints(cv.meanErrorPt) !== "good" && room > 0) {
        const extras = this.pickExtras(cv, Math.min(room, 4));
        if (extras.length > 0) {
          for (const [nx, ny] of extras) {
            this.usedExtras.add(`${nx},${ny}`);
            this.queue.push({ id: `t${nx},${ny}`, nx, ny, phase: "train" });
          }
          return;
        }
      }
      this.validationStarted = true;
      for (const [nx, ny] of VALIDATION.slice(0, this.o.validationPoints)) {
        this.queue.push({ id: `v${nx},${ny}`, nx, ny, phase: "validate" });
      }
      return;
    }
    this.finished = this.finish();
  }

  /** Extra points where held-out error is worst (inverse-distance weighted over targets). */
  private pickExtras(cv: CrossValidation, count: number): [number, number][] {
    const d = this.o.display;
    const errs = cv.perGroup.map((g) => ({
      nx: (g.x - d.x) / d.width,
      ny: (g.y - d.y) / d.height,
      e: g.errorPt,
    }));
    const scored = EXTRA.filter(([nx, ny]) => !this.usedExtras.has(`${nx},${ny}`)).map(([nx, ny]) => {
      let w = 0;
      let s = 0;
      for (const t of errs) {
        const dist = Math.hypot(t.nx - nx, t.ny - ny) + 0.05;
        w += 1 / dist ** 2;
        s += t.e / dist ** 2;
      }
      return { p: [nx, ny] as [number, number], score: s / Math.max(w, 1e-9) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, count).map((s) => s.p);
  }

  private finish(): SessionStep {
    const sel = this.selection!;
    const validation: ValidationResult[] = [];
    const allIris: number[] = [];
    for (const s of this.trainingSamples) allIris.push(s.input.irisDiameter);
    for (const [nx, ny] of VALIDATION.slice(0, this.o.validationPoints)) {
      const inputs = this.collected.get(`v${nx},${ny}`) ?? [];
      const preds = inputs.map((i) => predictModel(sel.model, i)).filter((p) => p !== null);
      if (preds.length === 0) continue;
      for (const i of inputs) allIris.push(i.irisDiameter);
      const g = this.toGlobal(nx, ny);
      const mx = mean(preds.map((p) => p.x));
      const my = mean(preds.map((p) => p.y));
      const precision = Math.sqrt(mean(preds.map((p) => (p.x - mx) ** 2 + (p.y - my) ** 2)));
      validation.push({
        x: g.x,
        y: g.y,
        errorPt: Math.hypot(mx - g.x, my - g.y),
        precisionPt: precision,
        samples: preds.length,
      });
    }
    if (validation.length < 2) {
      return {
        kind: "failed",
        reason: "The check dots weren't seen clearly. Rest for a moment, then try again.",
      };
    }
    const meanErrorPt = mean(validation.map((v) => v.errorPt));
    const distanceCm = viewingDistanceCm(allIris, this.o.geometry);
    const quality: CalibrationQuality = {
      grade: gradeForPoints(meanErrorPt),
      meanErrorPt,
      meanErrorDeg: distanceCm === null ? null : pointsToDegrees(meanErrorPt, distanceCm, this.o.geometry),
      points: new Set(this.trainingSamples.map((s) => s.group)).size,
      at: new Date().toISOString(),
    };
    return {
      kind: "done",
      result: {
        model: sel.model,
        quality,
        cvErrorPt: sel.cv.meanErrorPt,
        precisionPt: mean(validation.map((v) => v.precisionPt)),
        distanceCm,
        validation,
        trainingTargets: quality.points,
        samples: this.trainingSamples,
        geometry: this.o.geometry,
      },
    };
  }
}
