/**
 * Webcam provider: camera -> MediaPipe Face Landmarker -> FaceFrames, in a browser context (the
 * hidden engine window in AGENCY OS, or the web app). Frames are processed in memory and never
 * stored or sent anywhere. The landmarker is injected (see mediapipe.ts for the real one) so
 * this file has no MediaPipe dependency and tests can supply a fake.
 *
 * Uses requestVideoFrameCallback when available: it fires once per new camera frame (no wasted
 * work on repeated frames) and reports the capture time, which gives honest camera-to-event
 * latency. Falls back to requestAnimationFrame.
 */

import { type CameraErrorKind, cameraEnvironment, classifyCameraError, openCamera } from "../camera";
import type { Landmark } from "../landmarks";
import { meanLuminance } from "../quality";
import type { GazeProvider, ProviderFrame, ProviderStats } from "./types";

export interface LandmarkerResult {
  faceLandmarks: Landmark[][];
  faceBlendshapes?: { categories: { categoryName: string; score: number }[] }[];
  facialTransformationMatrixes?: { data: ArrayLike<number> }[];
}

export interface Landmarker {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): LandmarkerResult;
  close?(): void;
}

export type LandmarkerFactory = () => Promise<{ landmarker: Landmarker; delegate: "GPU" | "CPU" }>;

export type WebcamStatus = "off" | "starting" | "loading-model" | "running" | "error";

interface VideoFrameMeta {
  captureTime?: number;
  expectedDisplayTime?: number;
}

type RVFC = (cb: (now: number, meta: VideoFrameMeta) => void) => number;

export function blinkFromCategories(
  categories: readonly { categoryName: string; score: number }[] | undefined,
): number | null {
  if (!categories || categories.length === 0) return null;
  let left: number | null = null;
  let right: number | null = null;
  for (const c of categories) {
    if (c.categoryName === "eyeBlinkLeft") left = c.score;
    if (c.categoryName === "eyeBlinkRight") right = c.score;
  }
  return left === null || right === null ? null : (left + right) / 2;
}

export class WebcamProvider implements GazeProvider {
  readonly id = "webcam";
  readonly kind = "face" as const;
  status: WebcamStatus = "off";
  error: CameraErrorKind | null = null;
  readonly video: HTMLVideoElement;

  private stream: MediaStream | null = null;
  private landmarker: Landmarker | null = null;
  private delegate: "GPU" | "CPU" | null = null;
  private running = false;
  private onFrame: ((f: ProviderFrame) => void) | null = null;
  private handle: number | null = null;
  private targetFps = 30;
  private lastProcessed = -Infinity;
  private lastTimestamp = 0;
  private frameTimes: number[] = [];
  private detectTimes: number[] = [];
  private brightnessCanvas: HTMLCanvasElement | null = null;
  private lastBrightnessAt = -Infinity;
  private brightness: number | null = null;
  private statusListeners = new Set<(s: WebcamStatus, e: CameraErrorKind | null) => void>();

  constructor(private readonly createLandmarker: LandmarkerFactory) {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute("aria-hidden", "true");
  }

  onStatus(listener: (s: WebcamStatus, e: CameraErrorKind | null) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: WebcamStatus, error: CameraErrorKind | null = null): void {
    this.status = status;
    this.error = error;
    for (const l of this.statusListeners) l(status, error);
  }

  setTargetFps(fps: number): void {
    this.targetFps = Math.max(1, fps);
  }

  stats(): ProviderStats {
    const d = this.detectTimes;
    return {
      fps: this.frameTimes.length,
      delegate: this.delegate,
      detectMs: d.length ? d.reduce((s, v) => s + v, 0) / d.length : null,
    };
  }

  async start(onFrame: (f: ProviderFrame) => void): Promise<void> {
    this.onFrame = onFrame;
    if (this.running || this.status === "starting" || this.status === "loading-model") return;
    this.setStatus("starting");
    try {
      this.stream = await openCamera();
    } catch (err) {
      this.setStatus("error", classifyCameraError(err, cameraEnvironment()));
      return;
    }
    this.stream.getVideoTracks()[0]?.addEventListener("ended", () => {
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
    if (!this.landmarker) {
      this.setStatus("loading-model");
      try {
        const made = await this.createLandmarker();
        this.landmarker = made.landmarker;
        this.delegate = made.delegate;
      } catch (err) {
        console.error("Face Landmarker failed to load", err);
        this.releaseCamera();
        this.setStatus("error", "model-failed");
        return;
      }
    }
    this.running = true;
    this.setStatus("running");
    this.schedule();
  }

  stop(): void {
    this.stopLoop();
    this.releaseCamera();
    this.setStatus("off");
  }

  private stopLoop(): void {
    this.running = false;
    if (this.handle !== null) {
      const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
      if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.handle);
      else cancelAnimationFrame(this.handle);
    }
    this.handle = null;
  }

  private releaseCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private schedule(): void {
    if (!this.running) return;
    const rvfc = (this.video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback;
    if (rvfc) {
      this.handle = rvfc.call(this.video, (_now, meta) => {
        this.process(meta.captureTime);
        this.schedule();
      });
    } else {
      this.handle = requestAnimationFrame(() => {
        this.process(undefined);
        this.schedule();
      });
    }
  }

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

  private process(captureTime: number | undefined): void {
    const lm = this.landmarker;
    if (!lm || this.video.readyState < 2) return;
    let now = performance.now();
    // Governor: skip camera frames when a lower rate was asked for (idle, paused).
    if (now - this.lastProcessed < (1000 / this.targetFps) * 0.8) return;
    this.lastProcessed = now;
    if (now <= this.lastTimestamp) now = this.lastTimestamp + 1;
    this.lastTimestamp = now;
    let result: LandmarkerResult;
    const before = performance.now();
    try {
      result = lm.detectForVideo(this.video, now);
    } catch (err) {
      console.error("detectForVideo failed", err);
      return;
    }
    const after = performance.now();
    this.detectTimes.push(after - before);
    if (this.detectTimes.length > 60) this.detectTimes.shift();
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter((t) => now - t < 1000);
    this.measureBrightness(now);
    const landmarks = result.faceLandmarks[0] ?? null;
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    this.onFrame?.({
      kind: "face",
      frame: {
        t: after,
        ...(captureTime !== undefined ? { captureT: captureTime } : {}),
        landmarks,
        matrix: matrix ? Array.from(matrix) : null,
        blink: blinkFromCategories(result.faceBlendshapes?.[0]?.categories),
        aspect: this.video.videoWidth / Math.max(1, this.video.videoHeight),
        brightness: this.brightness,
      },
    });
  }
}
