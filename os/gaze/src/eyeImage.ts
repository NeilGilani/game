/**
 * Eye-image features from RealEye Webcam EyeTracker Light Open
 * (github.com/RealEye-io/webcam-eyetracker-light-open, the tracker behind realeye.io; AGPL-3.0 or
 * RealEye's commercial license, see THIRD_PARTY.md). Their tracker reads the eyes themselves, not
 * only the iris landmarks: each eye is cropped with its own landmarks, shrunk to 40x20 grey pixels
 * and normalised for brightness, next to 30 face landmark coordinates. A ridge regression from
 * those to the screen gives it about 120 px accuracy on ordinary webcams, by their measurements.
 * We call their extractor unchanged and fit their kind of model in calibration/appearance.ts.
 *
 * Only the pixels around the eyes are read from the video (a few hundred pixels across, not the
 * whole frame). With the landmarks moved into that region the result is identical to running the
 * extractor on the full frame (tests/eyeImage.test.ts). The features live for one frame, or for the
 * 5-second scan; they are never stored or sent anywhere.
 */

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { extractCombinedFeatures } from "@realeye-io/webcam-eyetracker-light-open";

import type { Landmark } from "./landmarks";

/** RealEye's eye crop (EYE_INPUT_WIDTH x EYE_INPUT_HEIGHT). */
const EYE_W = 40;
const EYE_H = 20;

/** 30 landmark coordinates and two 40x20 eye crops (RealEye's vector without its bias term). */
export const EYE_FEATURES = 30 + 2 * EYE_W * EYE_H;

/** The landmarks RealEye builds its two eye boxes from (REALEYE_EYE_INDICES). */
const EYE_BOX_LANDMARKS = [
  247, 130, 25, 222, 223, 224, 190, 243, 233, 23, 112, 414, 463, 453, 442, 443, 444, 467, 359, 255, 341, 253,
];

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The pixels to read: both eye boxes, with room for RealEye's 1.2x box scale and 4 px padding.
 * Null when the eyes are too small to crop or the landmarks are incomplete.
 */
export function eyeRegion(landmarks: readonly Landmark[], width: number, height: number): Region | null {
  if (landmarks.length < 478 || width < 2 || height < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of EYE_BOX_LANDMARKS) {
    const l = landmarks[i]!;
    const x = l.x * width;
    const y = l.y * height;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 8 && h > 2)) return null;
  const mx = w * 0.25 + 8;
  const my = h * 0.5 + 8;
  const x0 = Math.max(0, Math.floor(minX - mx));
  const y0 = Math.max(0, Math.floor(minY - my));
  const x1 = Math.min(width, Math.ceil(maxX + mx));
  const y1 = Math.min(height, Math.ceil(maxY + my));
  if (x1 - x0 < 8 || y1 - y0 < 4) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** RealEye's face box (all landmarks plus 5 %), in full-frame pixels. */
function faceBox(landmarks: readonly Landmark[], width: number, height: number): Region {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of landmarks) {
    minX = Math.min(minX, l.x * width);
    minY = Math.min(minY, l.y * height);
    maxX = Math.max(maxX, l.x * width);
    maxY = Math.max(maxY, l.y * height);
  }
  const px = (maxX - minX) * 0.05;
  const py = (maxY - minY) * 0.05;
  return {
    x: Math.max(0, minX - px),
    y: Math.max(0, minY - py),
    width: maxX - minX + 2 * px,
    height: maxY - minY + 2 * py,
  };
}

/**
 * RealEye's features for a frame `width` x `height`, given only the pixels of `region` (an
 * ImageData of exactly that region). Null if the extractor fails or returns anything not finite.
 */
export function eyeFeaturesFromRegion(
  pixels: ImageData,
  region: Region,
  landmarks: readonly Landmark[],
  width: number,
  height: number,
): Float32Array | null {
  const box = faceBox(landmarks, width, height);
  const local = landmarks.map((l): NormalizedLandmark => ({
    x: (l.x * width - region.x) / region.width,
    y: (l.y * height - region.y) / region.height,
    z: l.z ?? 0,
    visibility: 0,
  }));
  let raw: number[];
  try {
    raw = extractCombinedFeatures(
      pixels,
      { x: box.x - region.x, y: box.y - region.y, width: box.width, height: box.height },
      [],
      true,
      local,
      region.width,
      region.height,
      EYE_W,
      EYE_H,
    );
  } catch {
    return null;
  }
  if (raw.length !== EYE_FEATURES + 1) return null;
  const out = new Float32Array(EYE_FEATURES);
  for (let i = 0; i < EYE_FEATURES; i++) {
    const v = raw[i]!;
    if (!Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

/** Reads RealEye's features from the live video, one small canvas read per frame. */
export class EyeImageReader {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  read(
    source: CanvasImageSource,
    width: number,
    height: number,
    landmarks: readonly Landmark[] | null,
  ): Float32Array | null {
    if (!landmarks) return null;
    const region = eyeRegion(landmarks, width, height);
    if (!region) return null;
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = this.ctx;
    if (!ctx) return null;
    if (this.canvas.width !== region.width) this.canvas.width = region.width;
    if (this.canvas.height !== region.height) this.canvas.height = region.height;
    try {
      ctx.drawImage(
        source,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        region.width,
        region.height,
      );
      const pixels = ctx.getImageData(0, 0, region.width, region.height);
      return eyeFeaturesFromRegion(pixels, region, landmarks, width, height);
    } catch {
      return null;
    }
  }
}
