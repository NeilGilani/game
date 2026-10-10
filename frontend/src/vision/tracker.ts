/**
 * The live camera pipeline. Runs MediaPipe Face Landmarker on webcam frames in this
 * browser; frames are never stored or uploaded. Each frame produces features, a blink
 * score, quality issues and (once calibrated) a smoothed on-screen pointer estimate.
 */

import type { FaceLandmarker as FaceLandmarkerType } from "@mediapipe/tasks-vision";
import { type CameraErrorKind, cameraEnvironment, classifyCameraError, openCamera } from "./camera";
import { type CalibrationModel, featureVector, predict } from "./calibration";
import { OpennessBlink } from "./blink";
import { type GazeFeatures, blinkFromBlendshapes, extractFeatures } from "./landmarks";
import { PointFilter } from "./oneEuro";
import {
  type QualityIssue,
  assessBrightness,
  assessFace,
  meanLuminance,
  trackingConfidence,
} from "./quality";

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

export class VisionEngine {
  status: VisionStatus = "off";
  error: CameraErrorKind | null = null;
  stats: VisionStats = { fps: 0, delegate: null, modelLoadedMs: null, videoSize: null };
  readonly video: HTMLVideoElement;
  last: VisionFrame | null = null;

  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarkerType | null = null;
  private running = false;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private model: CalibrationModel | null = null;
  private filter = new PointFilter({ minCutoff: 0.6, beta: 0.004, dCutoff: 1 });
  private opennessBlink = new OpennessBlink();
  private lastTimestamp = 0;
  private frameTimes: number[] = [];
  private brightnessCanvas: HTMLCanvasElement | null = null;
  private lastBrightnessAt = 0;
  private brightness: number | null = null;
  private loopHandle: number | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute("aria-hidden", "true");
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
    if (this.status === "running" || this.status === "starting" || this.status === "loading-model") return;
    this.setStatus("starting");
    try {
      this.stream = await openCamera();
    } catch (err) {
      this.setStatus("error", classifyCameraError(err, cameraEnvironment()));
      return;
    }
    const track = this.stream.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      if (this.running) {
        this.stopLoop();
        this.setStatus("error", "stream-lost");
      }
    });
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch (err) {
      this.releaseCamera();
      this.setStatus("error", classifyCameraError(err, cameraEnvironment()));
      return;
    }
    this.stats.videoSize = { width: this.video.videoWidth, height: this.video.videoHeight };

    if (!this.landmarker) {
      this.setStatus("loading-model");
      const started = performance.now();
      try {
        this.landmarker = await this.createLandmarker();
        this.stats.modelLoadedMs = Math.round(performance.now() - started);
      } catch (err) {
        console.error("Face Landmarker failed to load", err);
        this.releaseCamera();
        this.setStatus("error", "model-failed");
        return;
      }
    }
    this.running = true;
    this.setStatus("running");
    this.loop();
  }

  private async createLandmarker(): Promise<FaceLandmarkerType> {
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
      const lm = await FaceLandmarker.createFromOptions(fileset, options("GPU"));
      this.stats.delegate = "GPU";
      return lm;
    } catch (gpuError) {
      console.warn("GPU delegate unavailable, using CPU", gpuError);
      const lm = await FaceLandmarker.createFromOptions(fileset, options("CPU"));
      this.stats.delegate = "CPU";
      return lm;
    }
  }

  /** Stop processing frames but keep the camera on (e.g. while the person rests). */
  pause(): void {
    if (this.status !== "running") return;
    this.stopLoop();
    this.setStatus("paused");
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.running = true;
    this.setStatus("running");
    this.loop();
  }

  stop(): void {
    this.stopLoop();
    this.releaseCamera();
    this.last = null;
    this.setStatus("off");
  }

  private stopLoop(): void {
    this.running = false;
    if (this.loopHandle !== null) cancelAnimationFrame(this.loopHandle);
    this.loopHandle = null;
  }

  private releaseCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.process();
    this.loopHandle = requestAnimationFrame(this.loop);
  };

  private measureBrightness(now: number): void {
    if (now - this.lastBrightnessAt < 1000 || !this.video.videoWidth) return;
    this.lastBrightnessAt = now;
    this.brightnessCanvas ??= document.createElement("canvas");
    const c = this.brightnessCanvas;
    c.width = 32;
    c.height = 24;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    this.brightness = meanLuminance(ctx.getImageData(0, 0, c.width, c.height).data, 1);
  }

  private process(): void {
    const lm = this.landmarker;
    if (!lm || this.video.readyState < 2) return;
    let now = performance.now();
    if (now <= this.lastTimestamp) now = this.lastTimestamp + 1;
    this.lastTimestamp = now;

    let result;
    try {
      result = lm.detectForVideo(this.video, now);
    } catch (err) {
      console.error("detectForVideo failed", err);
      return;
    }
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter((t) => now - t < 1000);
    this.stats.fps = this.frameTimes.length;
    this.measureBrightness(now);

    const aspect = this.video.videoWidth / Math.max(1, this.video.videoHeight);
    const landmarks = result.faceLandmarks[0];
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    const features = extractFeatures(landmarks, aspect, matrix);
    let blink = blinkFromBlendshapes(result.faceBlendshapes?.[0]?.categories);
    if (blink === null && features) blink = this.opennessBlink.score(features.openness);
    const issues = assessFace(features);
    const light = assessBrightness(this.brightness);
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
    for (const l of this.listeners) l(frame);
  }
}

let shared: VisionEngine | null = null;

export function visionEngine(): VisionEngine {
  shared ??= new VisionEngine();
  return shared;
}
