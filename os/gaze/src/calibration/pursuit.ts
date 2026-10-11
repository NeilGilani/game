/**
 * The 5-second eye scan: instead of a dozen dots to stare at, one light glides around the screen
 * and the person follows it with their eyes (smooth pursuit). Every frame of the glide is a
 * training sample, so a few seconds fit the same calibration v2 model the dot calibration fits.
 * Accuracy is estimated by cross-validation on stretches of the path the model didn't train on.
 * After that, continuous recalibration keeps improving it from everyday selections.
 *
 * The glide: centre, top-left, top-right, through the centre to bottom-left, bottom-right, back to
 * the centre. Each leg eases in and out, so the eyes nearly stop at the corners and follow
 * smoothly in between, at about 60 % of the screen diagonal per second.
 *
 * Tried in simulation and left out (tests/pursuit.test.ts is the baseline): resting the light at
 * the corners, a slower glide, averaging more or fewer frames per sample, and measuring each
 * person's delay behind the light. None beat this; what limits accuracy is the noise in the eye
 * landmarks, which is why the camera runs at 1280x720 and the smoother ignores single wild frames.
 *
 * Pure logic, like CalibrationSession: the host draws the light at `at(ms)` and hands in each
 * frame's features with `add(ms, ...)`. Tests: tests/pursuit.test.ts.
 */

import type { GazeFeatures } from "../landmarks";
import { mean } from "../linalg";
import { type AppearanceFrame, fitAppearance } from "./appearance";
import { gazeInput } from "./features";
import {
  type Sample,
  type SelectOptions,
  aggregate,
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

export interface PursuitOptions {
  /** The display (or viewport) being calibrated, in the engine's points. */
  display: Bounds;
  /** Inset of the path from the edges, as a fraction of the display (0.1 = 10 %). */
  margin?: number;
  /** Average speed along the path, in display diagonals per second. */
  speed?: number;
  /** Time at the start, light still in the centre, for the eyes to find it (ms). */
  leadInMs?: number;
  /** Eyes (and the camera) trail a moving light slightly: frames are matched to where it was this long before. */
  lagMs?: number;
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

/** Waypoints inside the margins (0..1 each way). */
const PATH: readonly [number, number][] = [
  [0.5, 0.5],
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0.5, 0.5],
];

/** Frames are grouped into stretches this long for cross-validation. */
const GROUP_MS = 450;

const ease = (u: number) => u * u * (3 - 2 * u);

export class PursuitCalibration {
  readonly durationMs: number;
  private readonly legs: Leg[];
  private readonly leadInMs: number;
  private readonly lagMs: number;
  private readonly geometry: ViewingGeometry;
  private readonly search: SelectOptions;
  private samples: Sample[] = [];
  private eyeFrames: AppearanceFrame[] = [];
  private iris: number[] = [];

  constructor(options: PursuitOptions) {
    const d = options.display;
    const margin = options.margin ?? 0.1;
    const speed = options.speed ?? 0.6;
    this.leadInMs = options.leadInMs ?? 700;
    this.lagMs = options.lagMs ?? 80;
    this.geometry = options.geometry ?? DEFAULT_GEOMETRY;
    this.search = options.search ?? {};
    const place = ([u, v]: readonly [number, number]): Point => ({
      x: d.x + d.width * (margin + u * (1 - 2 * margin)),
      y: d.y + d.height * (margin + v * (1 - 2 * margin)),
    });
    const diagonal = Math.hypot(d.width, d.height);
    this.legs = [];
    let t = this.leadInMs;
    for (let i = 1; i < PATH.length; i++) {
      const from = place(PATH[i - 1]!);
      const to = place(PATH[i]!);
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
    return this.samples.length;
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
    const target = this.at(ms - this.lagMs);
    const group = Math.floor(ms / GROUP_MS);
    const input = gazeInput(features);
    this.samples.push({ x: target.x, y: target.y, input, group: `g${group}` });
    if (eyes) this.eyeFrames.push({ x: target.x, y: target.y, eyes, input, group });
    if (features.irisDiameter) this.iris.push(features.irisDiameter);
  }

  finish(): SessionStep {
    const groups = new Set(this.samples.map((s) => s.group));
    if (this.samples.length < 40 || groups.size < 6) {
      return {
        kind: "failed",
        reason:
          "Your eyes weren't seen clearly enough. Face the screen with light on your face and try again.",
      };
    }
    let data = aggregate(this.samples, 4);
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
    const appearance = fitAppearance(this.eyeFrames, data, selection.model.config);
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
      },
    };
  }
}
