/**
 * The 5-second eye scan: instead of a dozen dots to stare at, one light glides around the screen
 * and the person follows it with their eyes (smooth pursuit). Every frame of the glide is a
 * training sample, so a few seconds fit the same calibration v2 model the dot calibration fits.
 * Accuracy is estimated by cross-validation on stretches of the path the model didn't train on,
 * then measured on three quick check dots (check.ts). After that, continuous recalibration keeps
 * improving it from everyday selections.
 *
 * The glide: centre, top-left, top-right, through the centre to bottom-left, bottom-right, back to
 * the centre. Each leg eases in and out, so the eyes nearly stop at the corners and follow
 * smoothly in between, at about 60 % of the screen diagonal per second. A sweep in three rows
 * (top, middle, bottom; `path: "rows"`) takes the same time and lost to it on simulated people
 * (tests/scan.test.ts): with only three heights on screen, up and down are learned from less.
 *
 * Eyes, and the camera pipeline, trail a moving light. How far behind differs from person to
 * person (and camera to camera), so the scan measures it: it tries delays from 0 to 300 ms and
 * keeps the one at which the face points fit the light's path best. A fixed `lagMs` skips that.
 *
 * Tried in simulation and left out (tests/pursuit.test.ts is the baseline): resting the light at
 * the corners, a slower glide, and averaging more or fewer frames per sample. What limits accuracy
 * is the noise in the eye landmarks, which is why the camera runs at 1280x720 and the smoother
 * ignores single wild frames.
 *
 * Pure logic, like CalibrationSession: the host draws the light at `at(ms)` and hands in each
 * frame's features with `add(ms, ...)`. Tests: tests/pursuit.test.ts, tests/scan.test.ts.
 */

import type { GazeFeatures } from "../landmarks";
import { mean } from "../linalg";
import { type AppearanceFrame, fitAppearance } from "./appearance";
import { type GazeInput, gazeInput } from "./features";
import {
  type ModelConfig,
  type Sample,
  type SelectOptions,
  aggregate,
  fitModel,
  predictModel,
  rejectResidualOutliers,
  selectModel,
} from "./model";
import type { Bounds, SessionStep } from "./session";
import {
  DEFAULT_GEOMETRY,
  type ViewingGeometry,
  gradeForPoints,
  pointsToDegrees,
  viewingDistanceCm,
} from "./viewing";

/** Waypoints of each glide, inside the margins (0..1 each way). */
export const SCAN_PATHS = {
  corners: [
    [0.5, 0.5],
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
  ],
  rows: [
    [0.5, 0.5],
    [0, 0],
    [1, 0],
    [1, 0.5],
    [0, 0.5],
    [0, 1],
    [1, 1],
  ],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

export type ScanPath = keyof typeof SCAN_PATHS;

export interface PursuitOptions {
  /** The display (or viewport) being calibrated, in the engine's points. */
  display: Bounds;
  /** The glide (default "corners", the winner in simulation). */
  path?: ScanPath;
  /** Inset of the path from the edges, as a fraction of the display (0.1 = 10 %). */
  margin?: number;
  /** Average speed along the path, in display diagonals per second. */
  speed?: number;
  /** Time at the start, light still in the centre, for the eyes to find it (ms). */
  leadInMs?: number;
  /**
   * Eyes (and the camera) trail a moving light: frames are matched to where it was this long
   * before. Omit it to measure each person's own delay from the scan.
   */
  lagMs?: number;
  /** RealEye's 1 px crop augmentation in the eye-image model's final fit (default on; off to compare). */
  augment?: boolean;
  geometry?: ViewingGeometry;
  search?: SelectOptions;
}

type Point = { x: number; y: number };

interface Leg {
  from: Point;
  to: Point;
  start: number;
  end: number;
}

interface Frame {
  ms: number;
  input: GazeInput;
  eyes: Float32Array | null;
}

/** Frames are grouped into stretches this long for cross-validation. */
const GROUP_MS = 450;

/** Delays tried for each person (ms); the best is refined between neighbours. */
const LAGS = Array.from({ length: 16 }, (_, i) => i * 20);
/** A plain landmark model, fitted at each delay: the delay at which it fits best is the person's. */
const LAG_MODEL: ModelConfig = { eye: "binocular", degree: 2, head: "ray", lambda: 1e-2 };

const ease = (u: number) => u * u * (3 - 2 * u);

export class PursuitCalibration {
  readonly durationMs: number;
  readonly path: ScanPath;
  private readonly legs: Leg[];
  private readonly leadInMs: number;
  private readonly lagMs: number | null;
  private readonly geometry: ViewingGeometry;
  private readonly search: SelectOptions;
  private readonly augment: boolean;
  private recorded: Frame[] = [];
  private iris: number[] = [];

  constructor(options: PursuitOptions) {
    const d = options.display;
    const margin = options.margin ?? 0.1;
    const speed = options.speed ?? 0.6;
    this.path = options.path ?? "corners";
    this.leadInMs = options.leadInMs ?? 700;
    this.lagMs = options.lagMs ?? null;
    this.geometry = options.geometry ?? DEFAULT_GEOMETRY;
    this.search = options.search ?? {};
    this.augment = options.augment ?? true;
    const place = ([u, v]: readonly [number, number]): Point => ({
      x: d.x + d.width * (margin + u * (1 - 2 * margin)),
      y: d.y + d.height * (margin + v * (1 - 2 * margin)),
    });
    const diagonal = Math.hypot(d.width, d.height);
    const waypoints = SCAN_PATHS[this.path];
    this.legs = [];
    let t = this.leadInMs;
    for (let i = 1; i < waypoints.length; i++) {
      const from = place(waypoints[i - 1]!);
      const to = place(waypoints[i]!);
      const ms = Math.max(450, (1000 * Math.hypot(to.x - from.x, to.y - from.y)) / (speed * diagonal));
      this.legs.push({ from, to, start: t, end: t + ms });
      t += ms;
    }
    this.durationMs = t + 200;
  }

  /** Where the light is `ms` after the scan started. */
  at(ms: number): Point {
    const first = this.legs[0]!;
    if (ms <= first.start) return { ...first.from };
    for (const leg of this.legs) {
      if (ms <= leg.end) {
        const u = ease((ms - leg.start) / (leg.end - leg.start));
        return { x: leg.from.x + (leg.to.x - leg.from.x) * u, y: leg.from.y + (leg.to.y - leg.from.y) * u };
      }
    }
    return { ...this.legs[this.legs.length - 1]!.to };
  }

  /** Frames used so far. */
  get frames(): number {
    return this.recorded.length;
  }

  /**
   * A camera frame seen `ms` after the scan started, with its eye-image features when the camera
   * read them (eyeImage.ts). Blinks and poorly tracked frames are skipped.
   */
  add(
    ms: number,
    features: GazeFeatures | null,
    confidence: number,
    blink: number | null,
    eyes?: Float32Array | null,
  ): void {
    // Until the eyes have found the light, frames say nothing about where they look.
    if (ms < this.leadInMs * 0.6 || ms > this.durationMs) return;
    if (!features || confidence < 0.5 || (blink ?? 0) >= 0.4) return;
    this.recorded.push({ ms, input: gazeInput(features), eyes: eyes ?? null });
    if (features.irisDiameter) this.iris.push(features.irisDiameter);
  }

  /** Training samples with each frame matched to where the light was `lag` ms before it. */
  private samples(lag: number): Sample[] {
    return this.recorded.map((f) => {
      const target = this.at(f.ms - lag);
      return { x: target.x, y: target.y, input: f.input, group: `g${Math.floor(f.ms / GROUP_MS)}` };
    });
  }

  /**
   * How far this person's eyes (and camera) trail the light, in ms: the delay at which a plain
   * landmark model fits the path best, refined between the delays tried.
   */
  estimateLag(): number {
    const cost = LAGS.map((lag) => {
      const data = aggregate(this.samples(lag), 4);
      const model = fitModel(data, LAG_MODEL);
      if (!model) return Infinity;
      const errors = data.flatMap((s) => {
        const p = predictModel(model, s.input);
        return p ? [Math.hypot(p.x - s.x, p.y - s.y)] : [];
      });
      return errors.length ? mean(errors) : Infinity;
    });
    let i = 0;
    for (let k = 1; k < cost.length; k++) if (cost[k]! < cost[i]!) i = k;
    if (!Number.isFinite(cost[i]!)) return 100;
    if (i === 0 || i === cost.length - 1) return LAGS[i]!;
    // The minimum of the parabola through the best delay and its neighbours.
    const [a, b, c] = [cost[i - 1]!, cost[i]!, cost[i + 1]!];
    const curve = a - 2 * b + c;
    const step = LAGS[1]! - LAGS[0]!;
    const shift = curve > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve)) : 0;
    return LAGS[i]! + shift * step;
  }

  finish(): SessionStep {
    const groups = new Set(this.recorded.map((f) => Math.floor(f.ms / GROUP_MS)));
    if (this.recorded.length < 40 || groups.size < 6) {
      return {
        kind: "failed",
        reason:
          "Your eyes weren't seen clearly enough. Face the screen with light on your face and try again.",
      };
    }
    const lagMs = this.lagMs ?? this.estimateLag();
    let data = aggregate(this.samples(lagMs), 4);
    let selection = selectModel(data, this.search);
    if (!selection) {
      return {
        kind: "failed",
        reason: "AGENCY couldn't learn your eyes from that. Try again, following the light.",
      };
    }
    // Frames where the eyes jumped to catch up with the light, or glanced away, fit badly: refit without them.
    const cleaned = rejectResidualOutliers(data, selection.model);
    if (cleaned.length < data.length && cleaned.length >= data.length * 0.6) {
      const again = selectModel(cleaned, this.search);
      if (again) {
        selection = again;
        data = cleaned;
      }
    }
    // RealEye's eye-image model, blended in at the share the scan measured best (appearance.ts).
    const eyeFrames: AppearanceFrame[] = this.recorded.flatMap((f) => {
      if (!f.eyes) return [];
      const target = this.at(f.ms - lagMs);
      return [{ x: target.x, y: target.y, eyes: f.eyes, input: f.input, group: Math.floor(f.ms / GROUP_MS) }];
    });
    const appearance = fitAppearance(eyeFrames, data, selection.model.config, { augment: this.augment });
    const errorPt = selection.cv.meanErrorPt * (appearance?.ratio ?? 1);
    const residuals = data.map((s) => {
      const p = predictModel(selection.model, s.input);
      return p ? (p.x - s.x) ** 2 + (p.y - s.y) ** 2 : 0;
    });
    const distanceCm = viewingDistanceCm(this.iris, this.geometry);
    return {
      kind: "done",
      result: {
        model: selection.model,
        quality: {
          grade: gradeForPoints(errorPt),
          meanErrorPt: errorPt,
          meanErrorDeg: distanceCm === null ? null : pointsToDegrees(errorPt, distanceCm, this.geometry),
          points: groups.size,
          at: new Date().toISOString(),
        },
        cvErrorPt: errorPt,
        precisionPt: Math.sqrt(mean(residuals)),
        distanceCm,
        validation: [],
        trainingTargets: groups.size,
        samples: data,
        geometry: this.geometry,
        appearance: appearance?.calibration ?? null,
        realEye: appearance?.report ?? null,
        lagMs,
      },
    };
  }
}
