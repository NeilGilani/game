/**
 * Synthetic eye images in the shape of RealEye's features (../eyeImage.ts): 30 normalised landmark
 * coordinates, then two 40x20 grey eye crops, each normalised to zero mean and unit variance.
 *
 * The picture is drawn from where the eye really is (skin, the eye opening between the lids, the
 * iris and pupil at the true iris centre), but each crop box is placed from the noisy landmarks,
 * as RealEye places it from MediaPipe's. So the crop slips by a fraction of a pixel from frame to
 * frame, which is what RealEye's 1 px augmentation is for, and the pixels carry camera noise.
 *
 * Like the synthetic face, this is NOT a real eye: no eyelashes, reflections, glasses, lid
 * movement with gaze, blur or compression. It is good for comparing ways of fitting eye images
 * (with and without augmentation, one scan path or another), not for promising accuracy.
 */

import { LEFT_EYE, type Landmark, NOSE_TIP, RIGHT_EYE } from "../landmarks";
import { gaussian, rng } from "../linalg";
import { NO_NOISE, type RenderInput, type RenderedFrame, SyntheticFace } from "./face";

const CROP_W = 40;
const CROP_H = 20;
/** Crop box width over the corner-to-corner eye width (RealEye's box reaches past the corners). */
const BOX_SCALE = 1.4;

export interface EyeImageOptions {
  /** Grey-level noise per crop pixel (0..1 scale). */
  pixelNoise?: number;
}

type Px = { x: number; y: number };

export class SyntheticEyeImages {
  private readonly truth: SyntheticFace;
  private readonly rand: () => number;
  private readonly noise: number;

  constructor(
    private readonly face: SyntheticFace,
    seed = 1,
    options: EyeImageOptions = {},
  ) {
    this.truth = new SyntheticFace(face.anatomy, face.display, face.camera, NO_NOISE, seed);
    this.rand = rng(seed * 104729 + 7);
    this.noise = options.pixelNoise ?? 0.03;
  }

  /** Features for a frame the face rendered from `input` (`frame` holds its noisy landmarks). */
  render(input: RenderInput, frame: RenderedFrame): Float32Array {
    const true_ = this.truth.render(input).landmarks;
    const out = new Float32Array(30 + 2 * CROP_W * CROP_H);
    out.set(this.landmarkFeatures(frame.landmarks), 0);
    [RIGHT_EYE, LEFT_EYE].forEach((eye, e) => {
      out.set(this.crop(eye, true_, frame.landmarks), 30 + e * CROP_W * CROP_H);
    });
    return out;
  }

  private px(l: Landmark): Px {
    return { x: l.x * this.face.camera.widthPx, y: l.y * this.face.camera.heightPx };
  }

  /** RealEye's 15 landmark positions relative to the face box, normalised together. */
  private landmarkFeatures(lm: readonly Landmark[]): number[] {
    const irisCentre = (ids: readonly number[]): Landmark => ({
      x: ids.reduce((s, i) => s + lm[i]!.x, 0) / ids.length,
      y: ids.reduce((s, i) => s + lm[i]!.y, 0) / ids.length,
    });
    const points: Landmark[] = [
      irisCentre(RIGHT_EYE.iris),
      irisCentre(LEFT_EYE.iris),
      ...[RIGHT_EYE, LEFT_EYE].flatMap((e) => [lm[e.outer]!, lm[e.inner]!, lm[e.upper]!, lm[e.lower]!]),
      ...Array.from({ length: 5 }, () => lm[NOSE_TIP]!),
    ];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w = Math.max(...xs) - Math.min(...xs) || 1;
    const h = Math.max(...ys) - Math.min(...ys) || 1;
    return normalise(points.flatMap((p) => [(p.x - cx) / w, (p.y - cy) / h]));
  }

  private crop(eye: typeof LEFT_EYE, true_: readonly Landmark[], noisy: readonly Landmark[]): number[] {
    // The box, from the noisy corners (as the real extractor's comes from MediaPipe's landmarks).
    const o = this.px(noisy[eye.outer]!);
    const i = this.px(noisy[eye.inner]!);
    const width = Math.abs(i.x - o.x) * BOX_SCALE;
    const height = width / 2;
    const left = (o.x + i.x) / 2 - width / 2;
    const top = (o.y + i.y) / 2 - height / 2;

    // The scene, from where the eye really is.
    const to = this.px(true_[eye.outer]!);
    const ti = this.px(true_[eye.inner]!);
    const tu = this.px(true_[eye.upper]!);
    const tl = this.px(true_[eye.lower]!);
    const ring = eye.iris.map((k) => this.px(true_[k]!));
    const centre = this.px(true_[eye === RIGHT_EYE ? 468 : 473]!);
    const radius =
      (Math.hypot(ring[0]!.x - ring[2]!.x, ring[0]!.y - ring[2]!.y) +
        Math.hypot(ring[1]!.x - ring[3]!.x, ring[1]!.y - ring[3]!.y)) /
      4;
    const axis = { x: ti.x - to.x, y: ti.y - to.y };
    const len = Math.hypot(axis.x, axis.y) || 1;
    const ux = axis.x / len;
    const uy = axis.y / len;
    const lidMid = { x: (tu.x + tl.x) / 2, y: (tu.y + tl.y) / 2 };
    const halfOpen = Math.hypot(tu.x - tl.x, tu.y - tl.y) / 2;
    const soft = (d: number) => 1 / (1 + Math.exp(-d / 0.35));

    const shade = (x: number, y: number): number => {
      const t = ((x - to.x) * ux + (y - to.y) * uy) / len;
      const s = -(x - lidMid.x) * uy + (y - lidMid.y) * ux;
      const lid = halfOpen * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, t)))), 0.7);
      const inside = soft(lid - Math.abs(s));
      const r = Math.hypot(x - centre.x, y - centre.y);
      const iris = soft(radius - r);
      const pupil = soft(radius * 0.42 - r);
      const limbus = Math.exp(-(((r - radius) / 0.8) ** 2));
      const eyeShade = 0.9 - (0.9 - 0.34) * iris - 0.26 * pupil - 0.12 * limbus;
      const lash = Math.exp(-(((s + lid) / 0.9) ** 2)) * 0.35 * (t > 0 && t < 1 ? 1 : 0);
      return 0.7 * (1 - inside) + eyeShade * inside - lash;
    };

    const values: number[] = [];
    for (let r = 0; r < CROP_H; r++) {
      for (let c = 0; c < CROP_W; c++) {
        let v = 0;
        for (const [sx, sy] of [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ] as const) {
          v += shade(left + ((c + sx) * width) / CROP_W, top + ((r + sy) * height) / CROP_H);
        }
        values.push(v / 4 + this.noise * gaussian(this.rand));
      }
    }
    return normalise(values);
  }
}

function normalise(values: number[]): number[] {
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.max(Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length), 1e-6);
  return values.map((v) => (v - m) / sd);
}
