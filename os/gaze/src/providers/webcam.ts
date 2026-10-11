/**
 * Webcam provider: camera -> MediaPipe Face Landmarker -> FaceFrames, in a browser context (the
 * hidden engine window in AGENCY OS, or the web app). Frames are processed in memory and never
 * stored or sent anywhere. The landmarker is injected (see mediapipe.ts for the real one) so
 * this file has no MediaPipe dependency and tests can supply a fake.
 *
 * Frames arrive two ways at once, de-duplicated by the video's current time: requestVideoFrameCallback
 * (once per camera frame, with the capture time, which gives honest camera-to-event latency) and
 * a timer poll (works in hidden windows and where frame callbacks are throttled).
 */

import { type CameraErrorKind, cameraEnvironment, classifyCameraError, openCamera } from "../camera";
import { EyeImageReader } from "../eyeImage";
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

/**
 * How frames are scheduled. "video-frame": requestVideoFrameCallback only. "timer": a setTimeout
 * poll only (hidden pages get no frame callbacks; the window must disable background throttling,
 * Electron: webPreferences.backgroundThrottling = false). "auto" (default): both, de-duplicated.
 */
export type FrameScheduler = "auto" | "video-frame" | "timer";

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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFreshAt = 0;
  private lastVideoTime = -1;
  private targetFps = 30;
  /** Token bucket for the governor: jittery or bunched camera frames don't cause drops. */
  private tokens = 1;
  private lastTokenAt: number | null = null;
  private lastTimestamp = 0;
  private frameTimes: number[] = [];
  private offeredTimes: number[] = [];
  private detectTimes: number[] = [];
  private brightnessCanvas: HTMLCanvasElement | null = null;
  private lastBrightnessAt = -Infinity;
  private brightness: number | null = null;
  private readonly eyeReader = new EyeImageReader();
  /** Read RealEye's eye images each frame (the calibrated gaze model needs them; the eye cursor doesn't). */
  private readEyes = true;
  private statusListeners = new Set<(s: WebcamStatus, e: CameraErrorKind | null) => void>();

  constructor(
    private readonly createLandmarker: LandmarkerFactory,
    private readonly scheduler: FrameScheduler = "auto",
  ) {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute("aria-hidden", "true");
    // Browsers pause a video element when it is removed from the page (e.g. a camera preview that
    // closes). A live camera must keep going, or gaze and Lifeline's blink detection would stop.
    this.video.addEventListener("pause", () => {
      if (this.running && this.stream) void this.video.play().catch(() => undefined);
    });
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

  /** Turn the per-frame eye-image read on or off (a canvas read and feature extraction every frame). */
  setReadEyes(on: boolean): void {
    this.readEyes = on;
  }

  setTargetFps(fps: number): void {
    this.targetFps = Math.max(1, fps);
  }

  stats(): ProviderStats {
    const d = this.detectTimes;
    return {
      fps: this.frameTimes.length,
      cameraFps: this.offeredTimes.length,
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
    this.lastFreshAt = performance.now();
    this.videoLoop();
    this.pollLoop();
  }

  stop(): void {
    this.stopLoop();
    this.releaseCamera();
    this.setStatus("off");
  }

  private stopLoop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.handle !== null) {
      const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
      v.cancelVideoFrameCallback?.(this.handle);
    }
    this.handle = null;
  }

  private releaseCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Once per new camera frame, with its capture time (does not fire in hidden pages). */
  private videoLoop(): void {
    if (!this.running || this.scheduler === "timer") return;
    const rvfc = (this.video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback;
    if (!rvfc) return;
    this.handle = rvfc.call(this.video, (_now, meta) => {
      this.handle = null;
      this.offer(meta.captureTime, false);
      this.videoLoop();
    });
  }

  /**
   * A timer poll alongside the video-frame callbacks: it keeps the engine fed in hidden windows
   * and wherever those callbacks are throttled (some headless browsers), and resumes a camera
   * video that the browser paused. Frames are de-duplicated by the video's current time.
   */
  private pollLoop(): void {
    if (!this.running || this.scheduler === "video-frame") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.video.paused && this.stream) void this.video.play().catch(() => undefined);
      this.offer(undefined, true);
      this.pollLoop();
    }, 1000 / 60);
  }

  private offer(captureTime: number | undefined, fromPoll: boolean): void {
    const now = performance.now();
    const time = this.video.currentTime;
    if (time !== this.lastVideoTime) {
      this.lastVideoTime = time;
      this.lastFreshAt = now;
      this.process(captureTime);
    } else if (fromPoll && now - this.lastFreshAt > 250) {
      // The stream's clock isn't advancing (seen with some fake or virtual cameras): read the
      // current picture anyway, at the governed rate, rather than going blind.
      this.process(undefined);
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
    this.offeredTimes.push(now);
    while (this.offeredTimes.length && now - this.offeredTimes[0]! > 1000) this.offeredTimes.shift();
    // Governor: skip camera frames only when a lower rate was asked for (idle, paused).
    if (this.lastTokenAt !== null)
      this.tokens = Math.min(2, this.tokens + ((now - this.lastTokenAt) * this.targetFps) / 1000);
    this.lastTokenAt = now;
    if (this.tokens < 0.95) return;
    this.tokens -= 1;
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
    if (this.detectTimes.length > 30) this.detectTimes.shift();
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter((t) => now - t < 1000);
    this.measureBrightness(now);
    const landmarks = result.faceLandmarks[0] ?? null;
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    // Same task as detectForVideo, so the same camera frame.
    const eyes = this.readEyes
      ? this.eyeReader.read(this.video, this.video.videoWidth, this.video.videoHeight, landmarks)
      : null;
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
        eyes,
      },
    });
  }
}
