/**
 * The web app's eye pointer as it ran before it moved to the v2 engine, frozen here so benchmarks
 * can compare against it: frontend/src/vision/tracker.ts, stabilizer.ts and input/InputLayer.tsx at
 * commit 9068e3a with default preferences. That is the 9-point legacy calibration, a One Euro
 * filter with the app's settings, the fixation-lock stabilizer (radius = "Steadiness needed",
 * 60 px), then hit-testing with a 48 px snap and the dwell engine (1200 ms, 60 px).
 *
 * Do not "fix" anything here: its job is to stay exactly what people used.
 */

import { type CalibrationModel, featureVector, predict } from "../src/calibration/legacy";
import { OpennessBlink } from "../src/blink";
import type { GazeSample } from "../src/contracts";
import { extractFeatures } from "../src/landmarks";
import { PointFilter } from "../src/oneEuro";
import { trackingConfidence } from "../src/quality";
import type { SimFrame } from "../src/synth/scenarios";

export interface StabilizerOptions {
  radius: number;
  drift: number;
  jump: number;
  confirmFrames: number;
}

type Point = { x: number; y: number };

/** frontend/src/vision/stabilizer.ts at 9068e3a, unchanged. */
export class GazeStabilizer {
  private options: StabilizerOptions;
  private pointer: Point | null = null;
  private outside = 0;
  private moving = false;
  private target: Point | null = null;

  constructor(options: Partial<StabilizerOptions> = {}) {
    this.options = { radius: 60, drift: 0.06, jump: 0.55, confirmFrames: 2, ...options };
  }

  update(p: Point): Point {
    const o = this.options;
    if (!this.pointer) {
      this.pointer = { ...p };
      return { ...p };
    }
    const d = Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y);
    if (this.moving) {
      this.target = p;
      this.step(p, o.jump);
      if (Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y) < o.radius * 0.5) this.moving = false;
      return { ...this.pointer };
    }
    if (d > o.radius) {
      this.outside += 1;
      this.target = this.target ? { x: (this.target.x + p.x) / 2, y: (this.target.y + p.y) / 2 } : { ...p };
      if (this.outside >= o.confirmFrames) {
        this.moving = true;
        this.outside = 0;
        this.step(this.target, o.jump);
      }
      return { ...this.pointer };
    }
    this.outside = 0;
    this.target = null;
    this.step(p, o.drift);
    return { ...this.pointer };
  }

  private step(to: Point, k: number): void {
    if (!this.pointer) return;
    this.pointer = {
      x: this.pointer.x + (to.x - this.pointer.x) * k,
      y: this.pointer.y + (to.y - this.pointer.y) * k,
    };
  }
}

/** The app's One Euro settings for a "Steadiness needed" preference (input.tsx setSmoothing). */
export function oldAppSmoothing(stabilityPx = 60): { minCutoff: number; beta: number; dCutoff: number } {
  const s = Math.max(0, Math.min(1, 1 - (stabilityPx - 10) / 290));
  return { minCutoff: 0.1 + s * 0.5, beta: 0.001 + s * 0.004, dCutoff: 1 };
}

export interface OldAppStep {
  sample: GazeSample | null;
  raw: Point | null;
  computeMs: number;
}

/** VisionEngine.process at 9068e3a, with the viewport the size of `viewport`. */
export function oldAppPipeline(
  model: CalibrationModel,
  viewport: { width: number; height: number },
  stabilityPx = 60,
): { name: string; step: (f: SimFrame) => OldAppStep } {
  const filter = new PointFilter(oldAppSmoothing(stabilityPx));
  const stabilizer = new GazeStabilizer({ radius: Math.max(20, Math.min(200, stabilityPx)) });
  const openness = new OpennessBlink();
  let last: Point | null = null;
  return {
    name: "old app (v1 + One Euro + stabilizer)",
    step(f) {
      const start = performance.now();
      const features = extractFeatures(f.frame.landmarks, f.frame.aspect, f.frame.matrix);
      let blink: number | null = f.frame.blinkScore;
      if (blink === null && features) blink = openness.score(features.openness);
      const confidence = trackingConfidence(features, blink);
      let pointer: Point | null = null;
      let raw: Point | null = null;
      if (features && confidence >= 0.5) {
        const p = predict(model, featureVector(features, model.set));
        raw = { x: p.x * viewport.width, y: p.y * viewport.height };
        const x = Math.max(0, Math.min(1, p.x)) * viewport.width;
        const y = Math.max(0, Math.min(1, p.y)) * viewport.height;
        pointer = stabilizer.update(filter.filter(x, y, f.t));
      } else if (last && confidence < 0.5) {
        pointer = last;
      }
      if (pointer) last = pointer;
      return {
        sample: pointer
          ? { t: f.t, x: pointer.x, y: pointer.y, confidence, fixation: false, source: "webcam-gaze" }
          : null,
        raw,
        computeMs: performance.now() - start,
      };
    },
  };
}
