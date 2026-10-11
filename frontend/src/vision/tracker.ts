/**
 * The live camera pipeline for the web app, built on @agency/gaze (os/gaze). The WebcamProvider
 * runs MediaPipe Face Landmarker on webcam frames in this browser. Frames are never stored or
 * uploaded. Every frame goes through the package's GazeEngine, the same engine AGENCY OS uses:
 * calibration v2, fixation smoothing, continuous recalibration from everyday selections, and the
 * head pointer. Each frame produces features, a blink score, quality issues and, once calibrated
 * (or always, with the head pointer), an on-screen pointer in viewport pixels.
 *
 * The engine works in the viewport the calibration was made in (CSS pixels). If the window is a
 * different size now, the pointer is scaled to fit, as the old calibration did.
 *
 * Measured on simulated frames (os/gaze/bench/results/app.md): the old pipeline (legacy
 * calibration, One Euro filter, fixation-lock stabilizer) never completed a dwell on AGENCY's
 * smallest 96 px targets; this one picks the right one 90 % of the time with a still head and 73 %
 * with natural head movement. Adding the old stabilizer on top made accuracy worse, so it's gone.
 */

import { type CameraErrorKind } from "../../../os/gaze/src/camera";
import { ScanCheck } from "../../../os/gaze/src/calibration/check";
import { PursuitCalibration } from "../../../os/gaze/src/calibration/pursuit";
import type { CalibrationResult } from "../../../os/gaze/src/calibration/session";
import type { TouchUpResult } from "../../../os/gaze/src/calibration/touchup";
import { type CalibrationRun, type EngineAdvice, GazeEngine } from "../../../os/gaze/src/engine";
import type { PaceState } from "../../../os/gaze/src/input/pace";
import type { GazeFeatures } from "../../../os/gaze/src/landmarks";
import type { QualityIssue } from "../../../os/gaze/src/quality";
import { singleDisplay } from "../../../os/gaze/src/screen";
import type { FaceFrame } from "../../../os/gaze/src/providers/types";
import { type LandmarkerFactory, WebcamProvider } from "../../../os/gaze/src/providers/webcam";

import { type StoredCalibration, storeCalibration } from "./calibrationStore";

export type VisionStatus = "off" | "starting" | "loading-model" | "running" | "paused" | "error";

/** "gaze": calibrated eye gaze. "head": the pointer follows small head turns, no calibration. */
export type PointerKind = "gaze" | "head";

export interface VisionFrame {
  t: number;
  face: boolean;
  features: GazeFeatures | null;
  blink: number | null;
  /** How trustworthy the pointer is on this frame (below 0.5: don't start or continue a dwell). */
  confidence: number;
  /** Whether the face itself is tracked well (pose, distance, eyes open), pointer or not. */
  trackingConfidence: number;
  issues: QualityIssue[];
  /** Raw landmarks for the preview overlay only (never persisted). */
  landmarks: { x: number; y: number }[] | null;
  /** Pointer in viewport pixels: calibrated gaze, or the head pointer. Null until there is one. */
  pointer: { x: number; y: number } | null;
  /** True while the eyes hold still on one place (always true for the head pointer). */
  fixation: boolean;
  /** RealEye's eye-image features (os/gaze/src/eyeImage.ts), for the eye scan. Never stored. */
  eyes: Float32Array | null;
}

export interface VisionStats {
  fps: number;
  delegate: "GPU" | "CPU" | null;
  modelLoadedMs: number | null;
  videoSize: { width: number; height: number } | null;
}

type Listener = (frame: VisionFrame) => void;
type StatusListener = (status: VisionStatus, error: CameraErrorKind | null) => void;

const BASE = import.meta.env.BASE_URL ?? "/";

/** MediaPipe from the app's own vendored assets (public/mediapipe, public/models), GPU then CPU. */
const mediapipe: LandmarkerFactory = async () => {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: `${BASE}models/face_landmarker.task`, delegate },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("GPU")), delegate: "GPU" };
  } catch (gpuError) {
    console.warn("GPU delegate unavailable, using CPU", gpuError);
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("CPU")), delegate: "CPU" };
  }
};

const viewport = () => ({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) });

export class VisionEngine {
  status: VisionStatus = "off";
  error: CameraErrorKind | null = null;
  stats: VisionStats = { fps: 0, delegate: null, modelLoadedMs: null, videoSize: null };
  last: VisionFrame | null = null;

  /** The gaze engine every frame goes through (os/gaze/src/engine.ts). */
  readonly gaze: GazeEngine;
  private readonly camera: WebcamProvider;
  private paused = false;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private stored: StoredCalibration | null = null;
  /** The engine's screen: the calibration's viewport, or the current one without a calibration. */
  private space = { width: 1, height: 1 };
  private calibrating = false;
  /** Recent gaze selections (newest last), so a Back or Undo soon after one can be reported. */
  private selections: { id: string; t: number }[] = [];
  /** Test hook only: frames come from feed() (a simulated person), not the webcam. */
  private external = false;
  private loadStarted = 0;

  constructor(factory: LandmarkerFactory = mediapipe) {
    this.space = viewport();
    this.gaze = new GazeEngine({ screen: singleDisplay(this.space.width, this.space.height) });
    this.camera = new WebcamProvider(async () => {
      this.loadStarted = performance.now();
      const made = await factory();
      this.stats.modelLoadedMs = Math.round(performance.now() - this.loadStarted);
      this.stats.delegate = made.delegate;
      return made;
    });
    this.camera.onStatus((s, e) => {
      if (s === "running") {
        this.stats.videoSize = { width: this.video.videoWidth, height: this.video.videoHeight };
      }
      this.setStatus(s === "running" && this.paused ? "paused" : s, e);
    });
    window.addEventListener("resize", () => this.fitScreen());
  }

  get video(): HTMLVideoElement {
    return this.camera.video;
  }

  get kind(): PointerKind {
    return this.gaze.mode;
  }

  onFrame(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: VisionStatus, error: CameraErrorKind | null = null): void {
    this.status = status;
    this.error = error;
    for (const l of this.statusListeners) l(status, error);
  }

  /** Gaze or head pointer. Switching to the head pointer centres it on the current pose. */
  setKind(kind: PointerKind): void {
    if (kind !== this.gaze.mode) this.gaze.setMode(kind);
  }

  /** The head pointer: wherever the head points now becomes the middle of the screen. */
  recentre(): void {
    this.gaze.recentreHeadPointer();
  }

  setCalibration(calibration: StoredCalibration | null): void {
    this.stored = calibration;
    this.fitScreen();
    this.gaze.setCalibration(calibration?.result ?? null);
  }

  get calibration(): StoredCalibration | null {
    return this.stored;
  }

  private fitScreen(): void {
    if (this.calibrating) return;
    const next = this.stored ? { width: this.stored.width, height: this.stored.height } : viewport();
    if (next.width === this.space.width && next.height === this.space.height) return;
    this.space = next;
    this.gaze.setScreen(singleDisplay(next.width, next.height));
  }

  /**
   * Start calibrating in the current viewport. Show each target of `run.next()` at its x, y (viewport
   * pixels) and call `run.collect(id)`; finish with `finishCalibration` or `cancelCalibration`.
   */
  startCalibration(): CalibrationRun {
    this.calibrating = true;
    this.space = viewport();
    this.gaze.setScreen(singleDisplay(this.space.width, this.space.height));
    return this.gaze.startCalibration();
  }

  /**
   * Start the 5-second eye scan in the current viewport: draw the light at `scan.at(ms)` and hand
   * in frames with `scan.add`; finish with `finishCalibration(step.result)` or `cancelCalibration`.
   */
  startEyeScan(): PursuitCalibration {
    this.calibrating = true;
    this.space = viewport();
    this.gaze.setScreen(singleDisplay(this.space.width, this.space.height));
    return new PursuitCalibration({ display: { x: 0, y: 0, ...this.space } });
  }

  /**
   * The three check dots after the eye scan, in the scan's viewport: draw the dot at `check.at(ms)`,
   * hand in frames with `check.add`, then `finishCalibration(check.finish())`.
   */
  startScanCheck(result: CalibrationResult): ScanCheck {
    return new ScanCheck(result, { display: { x: 0, y: 0, ...this.space } });
  }

  /** The finished calibration, ready to store and apply (setCalibration). */
  finishCalibration(result: CalibrationResult): StoredCalibration {
    this.gaze.endCalibration();
    this.calibrating = false;
    return storeCalibration(result, this.space.width, this.space.height);
  }

  cancelCalibration(): void {
    this.gaze.endCalibration();
    this.calibrating = false;
    this.fitScreen();
  }

  /**
   * A dwell selected this element (viewport rect). Feeds continuous recalibration: the engine
   * learns from selections that aren't undone, within strict bounds, and only if it helps.
   */
  selected(targetId: string, rect: DOMRect, t: number, dwellStartT: number): void {
    const sx = this.space.width / window.innerWidth;
    const sy = this.space.height / window.innerHeight;
    this.gaze.selection(
      targetId,
      { x: rect.left * sx, y: rect.top * sy, width: rect.width * sx, height: rect.height * sy },
      t,
      dwellStartT,
    );
    this.selections = [...this.selections.slice(-3), { id: targetId, t }];
  }

  /** The person undid a selection soon after making it (Back, Cancel): don't learn from it. */
  undone(targetId: string, t: number): void {
    this.gaze.undo(targetId, t);
  }

  /**
   * A Back, Cancel or Undo control was just chosen at `t`: the selection before it (within a few
   * seconds) was a mistake. Continuous recalibration won't learn from it, and pace counts it.
   */
  undoPrevious(t: number): void {
    const prev = [...this.selections].reverse().find((s) => s.t < t - 100 && t - s.t <= 6000);
    if (!prev) return;
    this.selections = this.selections.filter((s) => s !== prev);
    this.gaze.undo(prev.id, t);
  }

  /** What the engine advises: posture messages, touch-ups, pace changes, a fresh scan. */
  onAdvice(listener: (a: EngineAdvice) => void): () => void {
    return this.gaze.onAdvice(listener);
  }

  /** Dwell and target scales from pace (tiring over a session). */
  get pace(): PaceState {
    return this.gaze.paceState;
  }

  /** The person changed dwell or target settings: pace measures afresh. */
  rebasePace(): void {
    this.gaze.rebasePace();
  }

  /**
   * The 2-second touch-up: draw a dot at the returned point (viewport pixels) until `done`
   * resolves. Selection should be suspended meanwhile.
   */
  startTouchUp(): { x: number; y: number; done: Promise<TouchUpResult> } {
    const { target, done } = this.gaze.startTouchUp();
    return {
      x: (target.x * window.innerWidth) / this.space.width,
      y: (target.y * window.innerHeight) / this.space.height,
      done,
    };
  }

  cancelTouchUp(): void {
    this.gaze.cancelTouchUp();
  }

  /** The error circle around the pointer (viewport pixels, about two standard deviations). */
  get errorRadius(): number {
    return this.gaze.errorRadiusPt * (window.innerWidth / this.space.width);
  }

  async start(): Promise<void> {
    if (this.external) return;
    if (this.status === "paused") return this.resume();
    if (this.status === "running" || this.status === "starting" || this.status === "loading-model") return;
    this.paused = false;
    await this.camera.start((f) => {
      if (f.kind === "face") this.process(f.frame);
    });
  }

  /** Stop processing frames but keep the camera on (e.g. while the person rests). */
  pause(): void {
    if (this.status !== "running") return;
    this.paused = true;
    this.camera.setTargetFps(2); // frames are ignored while paused; keep the camera nearly idle
    this.setStatus("paused");
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.paused = false;
    this.camera.setTargetFps(30);
    this.setStatus("running");
  }

  /**
   * Test hook only (see main.tsx): run without the webcam, with frames delivered through feed().
   * End-to-end tests use it to drive the real engine with a simulated person (synthetic.ts).
   */
  useExternalFrames(): void {
    this.camera.stop();
    this.external = true;
    this.paused = false;
    this.setStatus("running");
  }

  /** Process one face frame from outside the webcam (tests). */
  feed(frame: FaceFrame): void {
    if (this.external && this.status === "running") this.process(frame);
  }

  stop(): void {
    this.paused = false;
    this.external = false;
    this.camera.stop();
    this.last = null;
    this.setStatus("off");
  }

  private process(f: FaceFrame): void {
    if (this.paused) return;
    if (!this.external) this.stats.fps = this.camera.stats().fps;
    this.gaze.handle({ kind: "face", frame: f });
    const d = this.gaze.last;
    if (!d) return;
    let pointer: VisionFrame["pointer"] = null;
    if (d.point && !this.calibrating) {
      pointer = {
        x: (d.point.x * window.innerWidth) / this.space.width,
        y: (d.point.y * window.innerHeight) / this.space.height,
      };
    }
    const head = this.gaze.mode === "head";
    const frame: VisionFrame = {
      t: d.t,
      face: d.face,
      features: d.features,
      blink: d.blink,
      confidence: pointer ? d.confidence : d.trackingConfidence,
      trackingConfidence: d.trackingConfidence,
      issues: d.issues,
      landmarks: f.landmarks ? f.landmarks.map((l) => ({ x: l.x, y: l.y })) : null,
      pointer,
      fixation: head || !!d.smoothed?.fixation,
      eyes: f.eyes ?? null,
    };
    this.last = frame;
    this.emit(frame);
  }

  emit(frame: VisionFrame): void {
    for (const l of this.listeners) l(frame);
  }
}

/**
 * Test hook: deliver a synthetic frame to listeners, exactly as the camera loop would.
 * Only exposed on window when localStorage "agency.testHooks" is "1" (see main.tsx), so
 * end-to-end tests can drive dwell selection through the real DOM wiring.
 */
export function injectFrame(engine: VisionEngine, partial: Partial<VisionFrame>): void {
  const confidence = partial.confidence ?? 1;
  const frame: VisionFrame = {
    t: performance.now(),
    face: true,
    features: null,
    blink: 0,
    confidence,
    trackingConfidence: confidence,
    issues: [],
    landmarks: null,
    pointer: null,
    fixation: true,
    eyes: null,
    ...partial,
  };
  engine.last = frame;
  engine.emit(frame);
}

let shared: VisionEngine | null = null;

export function visionEngine(): VisionEngine {
  shared ??= new VisionEngine();
  return shared;
}
