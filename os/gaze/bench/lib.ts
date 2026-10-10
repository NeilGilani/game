/**
 * Benchmark harness: run the CURRENT web-app pipeline (v1: 9-point legacy calibration + One Euro
 * pointer, exactly as frontend/src/vision/tracker.ts runs it with default preferences) and the
 * NEW engine (v2: adaptive calibration, head-pose normalisation, fixation smoothing, confidence)
 * on the very same synthetic frames, and measure them against known ground truth.
 *
 * Everything here is SIMULATED (see src/synth/face.ts). No real person or camera is involved.
 */

import { featureVector, fitCalibration, predict, type CalibrationModel } from "../src/calibration/legacy";
import { CalibrationSession, type CalibrationResult } from "../src/calibration/session";
import type { GazeSample, Target } from "../src/contracts";
import { GazeEngine } from "../src/engine";
import { DwellEngine } from "../src/input/dwell";
import { findTarget, type TargetRect } from "../src/input/targets";
import { extractFeatures } from "../src/landmarks";
import { OpennessBlink } from "../src/blink";
import { PointFilter } from "../src/oneEuro";
import { trackingConfidence } from "../src/quality";
import { singleDisplay } from "../src/screen";
import { driveCalibration } from "../src/synth/drive";
import {
  MACBOOK_DISPLAY,
  type NoiseModel,
  SyntheticFace,
  TYPICAL_NOISE,
  WEBCAM_640,
  randomAnatomy,
  screenPointToCamera,
} from "../src/synth/face";
import {
  type Fixation,
  GazeScript,
  HeadMotion,
  type HeadMotionKind,
  type SimFrame,
  simulate,
} from "../src/synth/scenarios";
import { rng } from "../src/linalg";

export const DISPLAY = { x: 0, y: 0, width: MACBOOK_DISPLAY.widthPt, height: MACBOOK_DISPLAY.heightPt };

export const NOISE: Record<"low" | "typical" | "high", NoiseModel> = {
  // A good camera in good light: half the landmark jitter.
  low: { landmarkPx: 0.3, irisPx: 0.4, poseDeg: 0.3, poseCm: 0.2 },
  typical: TYPICAL_NOISE,
  // A dimmer room or a worse camera: twice the landmark jitter.
  high: { landmarkPx: 1.2, irisPx: 1.6, poseDeg: 1.0, poseCm: 0.7 },
};

/** The web app's default One Euro settings (preferences dwell_stability_px = 60 -> sensitivity 0.83). */
export const V1_SMOOTHING = (() => {
  const s = 1 - (60 - 10) / 290;
  return { minCutoff: 0.3 + s * 1.2, beta: 0.002 + s * 0.01, dCutoff: 1 };
})();

export interface Subject {
  seed: number;
  face: SyntheticFace;
  head: HeadMotion;
  v1: CalibrationModel;
  v2: CalibrationResult;
  /** Time (ms) when calibration ended; use phases start after it. */
  t: number;
}

export function makeSubject(seed: number, motion: HeadMotionKind, noise: NoiseModel): Subject | null {
  const face = new SyntheticFace(randomAnatomy(seed), MACBOOK_DISPLAY, WEBCAM_640, noise, seed);
  const head = new HeadMotion({ kind: motion, seed });
  const session = new CalibrationSession({ display: DISPLAY });
  const run = driveCalibration(face, session, head, DISPLAY, { seed });
  if (run.step.kind !== "done") return null;
  // The current pipeline is a 9-point grid at 10/50/90 %: give it exactly those dots' frames.
  const grid = new Set([0.1, 0.5, 0.9]);
  const v1Samples = run.legacyTraining.filter((s) => grid.has(s.target.x) && grid.has(s.target.y));
  const v1 = fitCalibration(v1Samples, "gaze", { width: DISPLAY.width, height: DISPLAY.height });
  return { seed, face, head, v1, v2: run.step.result, t: run.endMs + 500 };
}

/** One pipeline turning frames into pointer samples (global points). */
export interface Pipeline {
  name: string;
  /** Returns the pointer sample for this frame, or null. Also returns the raw (unsmoothed) point. */
  step(f: SimFrame): { sample: GazeSample | null; raw: { x: number; y: number } | null; computeMs: number };
}

export function v1Pipeline(model: CalibrationModel): Pipeline {
  const filter = new PointFilter(V1_SMOOTHING);
  const openness = new OpennessBlink();
  let last: { x: number; y: number } | null = null;
  return {
    name: "v1 (current)",
    step(f) {
      const start = performance.now();
      const features = extractFeatures(f.frame.landmarks, f.frame.aspect, f.frame.matrix);
      let blink: number | null = f.frame.blinkScore;
      if (blink === null && features) blink = openness.score(features.openness);
      const confidence = trackingConfidence(features, blink);
      let raw: { x: number; y: number } | null = null;
      let pointer: { x: number; y: number } | null = null;
      if (features && confidence >= 0.5) {
        const p = predict(model, featureVector(features, "gaze"));
        raw = { x: p.x * DISPLAY.width, y: p.y * DISPLAY.height };
        const x = Math.max(0, Math.min(1, p.x)) * DISPLAY.width;
        const y = Math.max(0, Math.min(1, p.y)) * DISPLAY.height;
        pointer = filter.filter(x, y, f.t);
        last = pointer;
      } else if (last) {
        pointer = last;
      }
      const computeMs = performance.now() - start;
      return {
        sample: pointer
          ? { t: f.t, x: pointer.x, y: pointer.y, confidence, fixation: false, source: "webcam-gaze" }
          : null,
        raw,
        computeMs,
      };
    },
  };
}

export function v2Pipeline(
  result: CalibrationResult,
  options: { continuous?: boolean } = {},
): Pipeline & { engine: GazeEngine } {
  const engine = new GazeEngine({ screen: singleDisplay(DISPLAY.width, DISPLAY.height) });
  engine.setCalibration(result);
  let sample: GazeSample | null = null;
  engine.on((e) => {
    if (e.type === "sample") sample = e.sample;
  });
  return {
    name: options.continuous ? "v2 + continuous" : "v2 (new)",
    engine,
    step(f) {
      sample = null;
      const start = performance.now();
      engine.handle({
        kind: "face",
        frame: {
          t: f.t,
          landmarks: f.frame.landmarks,
          matrix: f.frame.matrix,
          blink: f.frame.blinkScore,
          aspect: f.frame.aspect,
        },
      });
      const computeMs = performance.now() - start;
      return { sample, raw: engine.last?.raw ?? null, computeMs };
    },
  };
}

/** Random fixations across the display, like looking around a screen. */
export function lookAround(seed: number, count: number, margin = 0.06): Fixation[] {
  const r = rng(seed * 977 + 1);
  return Array.from({ length: count }, () => ({
    x: DISPLAY.width * (margin + (1 - 2 * margin) * r()),
    y: DISPLAY.height * (margin + (1 - 2 * margin) * r()),
    durationMs: 700 + r() * 900,
  }));
}

/** Degrees of visual angle for an on-screen error at the head's real distance (ground truth). */
export function toDegrees(errPt: number, f: SimFrame, x: number, y: number): number {
  const p = screenPointToCamera(MACBOOK_DISPLAY, x, y);
  const h = f.head.position;
  const dist = Math.hypot(p[0] - h[0], p[1] - h[1], p[2] - h[2]);
  return (Math.atan2((errPt * MACBOOK_DISPLAY.mmPerPt) / 10, dist) * 180) / Math.PI;
}

export interface UseMetrics {
  accuracyPt: number;
  accuracyDeg: number;
  /** RMS of output samples around each fixation's mean (what the person sees as shake). */
  precisionPt: number;
  precisionDeg: number;
  /** Same on the unsmoothed estimates. */
  rawAccuracyPt: number;
  rawPrecisionPt: number;
  /** Median time from a saccade's start until the output is within 100 pt of where it settles. */
  settleMs: number;
  /** Share of fixation frames with confidence >= 0.5. */
  usable: number;
  computeMsPerFrame: number;
}

interface FixWindow {
  onset: number;
  end: number;
  x: number;
  y: number;
  amplitude: number;
}

function windows(fix: readonly Fixation[], t0: number): FixWindow[] {
  let t = t0;
  return fix.map((f, i) => {
    const prev = fix[i - 1];
    const w = {
      onset: t,
      end: t + f.durationMs,
      x: f.x,
      y: f.y,
      amplitude: prev ? Math.hypot(f.x - prev.x, f.y - prev.y) : 0,
    };
    t += f.durationMs;
    return w;
  });
}

/** Render a session once, so every pipeline sees exactly the same frames. */
export function render(
  subject: Subject,
  fixations: readonly Fixation[],
  startMs = subject.t,
  head = subject.head,
): SimFrame[] {
  const script = new GazeScript(fixations, { seed: subject.seed + 1000 });
  return [...simulate(subject.face, script, head, { startMs, seed: subject.seed + 7 })];
}

/** Run a pipeline over a look-around session and measure it. */
export function measureUse(
  frames: readonly SimFrame[],
  fixations: readonly Fixation[],
  startMs: number,
  pipeline: Pipeline,
): UseMetrics {
  const wins = windows(fixations, startMs);
  const out: {
    t: number;
    x: number;
    y: number;
    c: number;
    rx: number | null;
    ry: number | null;
    f: SimFrame;
  }[] = [];
  let compute = 0;
  let n = 0;
  for (const f of frames) {
    const r = pipeline.step(f);
    compute += r.computeMs;
    n += 1;
    if (r.sample)
      out.push({
        t: f.t,
        x: r.sample.x,
        y: r.sample.y,
        c: r.sample.confidence,
        rx: r.raw?.x ?? null,
        ry: r.raw?.y ?? null,
        f,
      });
  }
  const acc: number[] = [];
  const accDeg: number[] = [];
  const prec: number[] = [];
  const precDeg: number[] = [];
  const rawAcc: number[] = [];
  const rawPrec: number[] = [];
  const settle: number[] = [];
  let usable = 0;
  let fixFrames = 0;
  for (const w of wins) {
    const inWin = out.filter((s) => s.t >= w.onset + 300 && s.t < w.end);
    if (inWin.length < 5) continue;
    fixFrames += inWin.length;
    usable += inWin.filter((s) => s.c >= 0.5).length;
    const mx = inWin.reduce((a, s) => a + s.x, 0) / inWin.length;
    const my = inWin.reduce((a, s) => a + s.y, 0) / inWin.length;
    const e = Math.hypot(mx - w.x, my - w.y);
    acc.push(e);
    accDeg.push(toDegrees(e, inWin[0]!.f, w.x, w.y));
    const rms = Math.sqrt(inWin.reduce((a, s) => a + (s.x - mx) ** 2 + (s.y - my) ** 2, 0) / inWin.length);
    prec.push(rms);
    precDeg.push(toDegrees(rms, inWin[0]!.f, w.x, w.y));
    const raws = inWin.filter((s) => s.rx !== null);
    if (raws.length >= 5) {
      const rx = raws.reduce((a, s) => a + s.rx!, 0) / raws.length;
      const ry = raws.reduce((a, s) => a + s.ry!, 0) / raws.length;
      rawAcc.push(Math.hypot(rx - w.x, ry - w.y));
      rawPrec.push(
        Math.sqrt(raws.reduce((a, s) => a + (s.rx! - rx) ** 2 + (s.ry! - ry) ** 2, 0) / raws.length),
      );
    }
    if (w.amplitude > 300) {
      const after = out.filter((s) => s.t >= w.onset && s.t < w.end);
      const hit = after.find((s) => Math.hypot(s.x - mx, s.y - my) < 100);
      settle.push(hit ? hit.t - w.onset : w.end - w.onset);
    }
  }
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
  const med = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)]! : NaN;
  };
  return {
    accuracyPt: mean(acc),
    accuracyDeg: mean(accDeg),
    precisionPt: mean(prec),
    precisionDeg: mean(precDeg),
    rawAccuracyPt: mean(rawAcc),
    rawPrecisionPt: mean(rawPrec),
    settleMs: med(settle),
    usable: fixFrames ? usable / fixFrames : 0,
    computeMsPerFrame: compute / Math.max(n, 1),
  };
}

/** A grid of dwell targets (size, gap) covering an area: the worst case for reading. */
export function targetGrid(size: number, gap: number, area = DISPLAY): Target[] {
  const out: Target[] = [];
  for (let y = area.y + gap; y + size <= area.y + area.height; y += size + gap)
    for (let x = area.x + gap; x + size <= area.x + area.width; x += size + gap)
      out.push({
        id: `g${x},${y}`,
        rect: { x, y, width: size, height: size },
        role: "button",
        label: `${x},${y}`,
        source: "shell",
      });
  return out;
}

export function toRects(targets: readonly Target[]): TargetRect[] {
  return targets.map((t) => ({
    id: t.id,
    rect: { left: t.rect.x, top: t.rect.y, right: t.rect.x + t.rect.width, bottom: t.rect.y + t.rect.height },
  }));
}

/** Dwell exactly as the web app's InputLayer does (default preferences: 1200 ms, 60 px, snap 48). */
export function dwellRunner(targets: readonly Target[]) {
  const dwell = new DwellEngine({ dwellMs: 1200, stabilityPx: 60 });
  const rects = toRects(targets);
  return (s: GazeSample) => {
    const id = findTarget(s.x, s.y, rects, 48);
    const events = dwell.update({ t: s.t, x: s.x, y: s.y, confidence: s.confidence, targetId: id });
    return events.filter((e) => e.type === "activate").map((e) => e.targetId);
  };
}
