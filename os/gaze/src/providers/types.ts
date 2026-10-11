/**
 * Where gaze comes from. A provider produces either face landmarks (webcam, replay, synthetic)
 * that the engine turns into gaze, or ready-made pointer positions in global screen points
 * (mouse, an external eye tracker). Every provider is replaceable by a fake for development.
 */

import type { InputSource } from "../contracts";
import type { Landmark } from "../landmarks";

export interface FaceFrame {
  /** Engine clock (performance.now()) when the frame was processed. */
  t: number;
  /** When the camera captured the frame, same clock, if known (for latency). */
  captureT?: number;
  /** MediaPipe face landmarks (478 with iris), or null when no face was found. */
  landmarks: Landmark[] | null;
  /** Facial transformation matrix (column-major 4x4), when available. */
  matrix?: number[] | null;
  /** Mean of eyeBlinkLeft/Right blendshapes, when available. */
  blink?: number | null;
  /** Eye squint score 0..1 (MediaPipe eyeSquintLeft/Right), when blendshapes are on. */
  squint?: number | null;
  /** Image width / height. */
  aspect: number;
  /** Mean luminance 0..255, measured occasionally. */
  brightness?: number | null;
  /** RealEye's eye-image features for this frame (../eyeImage.ts), when read. Never stored. */
  eyes?: Float32Array | null;
}

export interface PointerFrame {
  t: number;
  captureT?: number;
  /** Global screen points. */
  x: number;
  y: number;
  confidence: number;
  source: InputSource;
}

export type ProviderFrame = { kind: "face"; frame: FaceFrame } | { kind: "pointer"; frame: PointerFrame };

export interface ProviderStats {
  /** Frames processed in the last second. */
  fps: number;
  /** Frames the camera delivered in the last second (processed or skipped), when known. */
  cameraFps?: number;
  delegate: "GPU" | "CPU" | null;
  /** Mean time spent in landmark detection per frame (ms). */
  detectMs: number | null;
}

export interface GazeProvider {
  readonly id: string;
  readonly kind: "face" | "pointer";
  start(onFrame: (f: ProviderFrame) => void): Promise<void>;
  stop(): void;
  /** Ask for a lower or higher processing rate (the governor's decision). */
  setTargetFps?(fps: number): void;
  stats?(): ProviderStats;
}
