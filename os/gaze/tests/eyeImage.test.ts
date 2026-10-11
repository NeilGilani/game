import { beforeAll, describe, expect, it } from "vitest";
import { EYE_FEATURES, eyeFeaturesFromRegion, eyeRegion } from "../src/eyeImage";
import type { Landmark } from "../src/landmarks";
import { rng } from "../src/linalg";

// RealEye's extractor builds ImageData objects; Node has none, so a minimal stand-in.
beforeAll(() => {
  class NodeImageData {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  (globalThis as { ImageData?: unknown }).ImageData ??= NodeImageData;
});

const W = 1280;
const H = 720;

/** A face-like set of 478 landmarks, with RealEye's eye-box landmarks around two eyes. */
function landmarks(seed: number): Landmark[] {
  const rand = rng(seed);
  const out: Landmark[] = Array.from({ length: 478 }, () => ({
    x: 0.5 + (rand() - 0.5) * 0.3,
    y: 0.5 + (rand() - 0.5) * 0.45,
    z: 0,
  }));
  const eye = (cx: number, ids: number[]) => {
    for (const i of ids) out[i] = { x: cx + (rand() - 0.5) * 0.07, y: 0.44 + (rand() - 0.5) * 0.03, z: 0 };
  };
  eye(0.43, [247, 130, 25, 222, 223, 224, 190, 243, 233, 23, 112]);
  eye(0.57, [414, 463, 453, 442, 443, 444, 467, 359, 255, 341, 253]);
  return out;
}

function frame(seed: number): ImageData {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? 255 : Math.floor(rand() * 256);
  return new ImageData(data, W, H);
}

function crop(img: ImageData, r: { x: number; y: number; width: number; height: number }): ImageData {
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4;
    data.set(img.data.subarray(from, from + r.width * 4), y * r.width * 4);
  }
  return new ImageData(data, r.width, r.height);
}

describe("RealEye eye-image features", () => {
  it("reading only the pixels around the eyes gives exactly the full-frame result", () => {
    for (const seed of [1, 2, 3]) {
      const lm = landmarks(seed);
      const img = frame(seed);
      const region = eyeRegion(lm, W, H)!;
      expect(region.width).toBeLessThan(W / 2);
      const full = eyeFeaturesFromRegion(img, { x: 0, y: 0, width: W, height: H }, lm, W, H)!;
      const local = eyeFeaturesFromRegion(crop(img, region), region, lm, W, H)!;
      expect(full).toHaveLength(EYE_FEATURES);
      expect(local).toHaveLength(EYE_FEATURES);
      let worst = 0;
      for (let i = 0; i < EYE_FEATURES; i++) worst = Math.max(worst, Math.abs(full[i]! - local[i]!));
      expect(worst).toBeLessThan(1e-5);
    }
  });

  it("reads a frame's eye features in a few milliseconds", () => {
    const lm = landmarks(4);
    const region = eyeRegion(lm, W, H)!;
    const pixels = crop(frame(4), region);
    eyeFeaturesFromRegion(pixels, region, lm, W, H);
    const started = performance.now();
    for (let i = 0; i < 50; i++) eyeFeaturesFromRegion(pixels, region, lm, W, H);
    const ms = (performance.now() - started) / 50;
    console.log(
      `RealEye eye features: ${ms.toFixed(2)} ms per frame (${region.width}x${region.height} px read)`,
    );
    expect(ms).toBeLessThan(10);
  });

  it("returns nothing without a full set of landmarks", () => {
    expect(eyeRegion(landmarks(1).slice(0, 468), W, H)).toBeNull();
  });
});
