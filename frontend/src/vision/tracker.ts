/**
 * The live camera pipeline for the web app, built on @agency/gaze (os/gaze): its WebcamProvider
 * runs MediaPipe Face Landmarker on webcam frames in this browser; frames are never stored or
 * uploaded. Each frame produces features, a blink score, quality issues and (once calibrated) a
 * smoothed on-screen pointer estimate in viewport pixels.
 *
 * AGENCY OS uses the package's GazeEngine instead (global screen points, calibration v2); this
 * file keeps the web app's existing API and behaviour.
 */

import { type CameraErrorKind } from "../../../os/gaze/src/camera";
import { type CalibrationModel, featureVector, predict } from "../../../os/gaze/src/calibration/legacy";
import { OpennessBlink } from "../../../os/gaze/src/blink";
import { type GazeFeatures, extractFeatures } from "../../../os/gaze/src/landmarks";
import { PointFilter } from "../../../os/gaze/src/oneEuro";
import {
  type QualityIssue,
  assessBrightness,
  assessFace,
  trackingConfidence,
} from "../../../os/gaze/src/quality";
import type { FaceFrame } from "../../../os/gaze/src/providers/types";
import { type LandmarkerFactory, WebcamProvider } from "../../../os/gaze/src/providers/webcam";

export type VisionStatus = "off" | "starting" | "loading-model" | "running" | "paused" | "error";

export interface VisionFrame {
  t: number;
  face: boolean;
  features: GazeFeatures | null;
  blink: number | null;
  confidence: number;
  issues: QualityIssue[];
  /** Raw landmarks for the preview overlay only (never persisted). */
  landmarks: { x: number; y: number }[] | null;
  /** Calibrated, smoothed pointer in viewport pixels, if a model is loaded. */
  pointer: { x: number; y: number } | null;
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

export class VisionEngine {
  status: VisionStatus = "off";
  error: CameraErrorKind | null = null;
  stats: VisionStats = { fps: 0, delegate: null, modelLoadedMs: null, videoSize: null };
  last: VisionFrame | null = null;

  private readonly camera: WebcamProvider;
  private paused = false;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private model: CalibrationModel | null = null;
  private filter = new PointFilter({ minCutoff: 0.6, beta: 0.004, dCutoff: 1 });
  private opennessBlink = new OpennessBlink();
  private loadStarted = 0;

  constructor(factory: LandmarkerFactory = mediapipe) {
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
  }

  get video(): HTMLVideoElement {
    return this.camera.video;
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

  setCalibration(model: CalibrationModel | null): void {
    this.model = model;
    this.filter.reset();
  }

  get calibration(): CalibrationModel | null {
    return this.model;
  }

  /** Higher sensitivity follows faster movements; lower smooths more. 0..1 */
  setSmoothing(sensitivity: number): void {
    const s = Math.max(0, Math.min(1, sensitivity));
    this.filter.setOptions({ minCutoff: 0.3 + s * 1.2, beta: 0.002 + s * 0.01 });
  }

  async start(): Promise<void> {
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

  stop(): void {
    this.paused = false;
    this.camera.stop();
    this.last = null;
    this.setStatus("off");
  }

  private process(f: FaceFrame): void {
    if (this.paused) return;
    this.stats.fps = this.camera.stats().fps;
    const now = f.t;
    const landmarks = f.landmarks;
    const features = extractFeatures(landmarks ?? undefined, f.aspect, f.matrix ?? undefined);
    let blink = f.blink ?? null;
    if (blink === null && features) blink = this.opennessBlink.score(features.openness);
    const issues = assessFace(features);
    const light = assessBrightness(f.brightness ?? null);
    if (light) issues.push(light);
    const confidence = trackingConfidence(features, blink);

    let pointer: VisionFrame["pointer"] = null;
    if (this.model && features && confidence >= 0.5) {
      const p = predict(this.model, featureVector(features, this.model.set));
      // The camera image is mirrored relative to the person, so screen x comes straight
      // from the fitted model; calibration learned the sign.
      const x = Math.max(0, Math.min(1, p.x)) * window.innerWidth;
      const y = Math.max(0, Math.min(1, p.y)) * window.innerHeight;
      pointer = this.filter.filter(x, y, now);
    } else if (this.last?.pointer && confidence < 0.5) {
      pointer = this.last.pointer; // hold position during a blink or brief loss
    }

    const frame: VisionFrame = {
      t: now,
      face: !!landmarks,
      features,
      blink,
      confidence,
      issues,
      landmarks: landmarks ? landmarks.map((l) => ({ x: l.x, y: l.y })) : null,
      pointer,
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
  const frame: VisionFrame = {
    t: performance.now(),
    face: true,
    features: null,
    blink: 0,
    confidence: 1,
    issues: [],
    landmarks: null,
    pointer: null,
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
