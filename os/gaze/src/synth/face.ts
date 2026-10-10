/**
 * A synthetic 3D face, eyes and webcam that render MediaPipe-shaped output (478 landmarks, the
 * facial transformation matrix, a blink score) for a person looking at a known point on a
 * screen. Used for tests and benchmarks with exact ground truth.
 *
 * This is NOT a real person or a real camera. It is a geometric model with randomised anatomy
 * (eyeball size, eye width, the angle between the eye's optical and visual axes, head
 * position) and landmark noise. Real MediaPipe output has error this model does not have
 * (systematic iris bias, lighting, glasses, lid occlusion), so accuracy measured on it is an
 * upper bound on what a real person gets. BENCHMARKS.md says so wherever its numbers appear.
 *
 * Frames: camera coordinates are centimetres, x to the right in the image, y down, z away
 * from the camera. The camera sits just above the top centre of the display, looking at the
 * person; the display lies in the plane z = 0.
 */

import { LEFT_EYE, type Landmark, MIN_LANDMARKS, NOSE_TIP, RIGHT_EYE } from "../landmarks";
import {
  type Mat3,
  type Vec3,
  add3,
  gaussian,
  mulMat3,
  mulMat3Vec,
  rng,
  rotationYPR,
  scale3,
  sub3,
  unit3,
} from "../linalg";

export const IRIS_DIAMETER_CM = 1.17;

export interface Anatomy {
  eyeballRadiusCm: number;
  eyeWidthCm: number;
  /** Distance between the two eyeball centres. */
  interocularCm: number;
  /** Optical axis minus visual axis, degrees (horizontal is nasal-positive, as in real eyes). */
  kappaHDeg: number;
  kappaVDeg: number;
  /** Lid opening as a fraction of eye width with the eyes open. */
  openness: number;
}

export const NOMINAL_ANATOMY: Anatomy = {
  eyeballRadiusCm: 1.2,
  eyeWidthCm: 3.0,
  interocularCm: 6.3,
  kappaHDeg: 5,
  kappaVDeg: 1.5,
  openness: 0.32,
};

/** A plausible, different person for each seed. */
export function randomAnatomy(seed: number): Anatomy {
  const r = rng(seed * 7919 + 13);
  const between = (a: number, b: number) => a + (b - a) * r();
  return {
    eyeballRadiusCm: between(1.1, 1.3),
    eyeWidthCm: between(2.7, 3.4),
    interocularCm: between(5.8, 7.0),
    kappaHDeg: between(2, 7),
    kappaVDeg: between(-1, 3),
    openness: between(0.26, 0.38),
  };
}

export interface Display {
  /** Size in points. */
  widthPt: number;
  heightPt: number;
  /** Physical size of one point. A 13-inch MacBook Air at its default resolution is about 0.197 mm. */
  mmPerPt: number;
  /** Gap between the camera and the top edge of the picture, cm. */
  cameraAboveCm: number;
  /** Where this display's top-left corner is in global screen points. */
  originPt: { x: number; y: number };
}

export const MACBOOK_DISPLAY: Display = {
  widthPt: 1470,
  heightPt: 956,
  mmPerPt: 0.197,
  cameraAboveCm: 0.8,
  originPt: { x: 0, y: 0 },
};

export interface Camera {
  widthPx: number;
  heightPx: number;
  /** Horizontal field of view, degrees. */
  hfovDeg: number;
}

export const WEBCAM_640: Camera = { widthPx: 640, heightPx: 480, hfovDeg: 62 };

export interface HeadState {
  /** Position of the point midway between the eyeball centres, cm. */
  position: Vec3;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface NoiseModel {
  /** Gaussian jitter on eye-corner, lid and nose landmarks, in camera pixels. */
  landmarkPx: number;
  /** Extra jitter on the iris ring, in camera pixels (shared by the ring, so it moves the centre). */
  irisPx: number;
  /** Jitter on the head rotation (degrees) and translation (cm) reported in the matrix. */
  poseDeg: number;
  poseCm: number;
}

export const TYPICAL_NOISE: NoiseModel = { landmarkPx: 0.6, irisPx: 0.8, poseDeg: 0.6, poseCm: 0.4 };
export const NO_NOISE: NoiseModel = { landmarkPx: 0, irisPx: 0, poseDeg: 0, poseCm: 0 };

export interface RenderInput {
  /** Point looked at, in global screen points; null means looking away / eyes closed handled by `closed`. */
  gaze: { x: number; y: number };
  head: HeadState;
  /** 0 = open, 1 = fully closed. */
  closure: number;
}

export interface RenderedFrame {
  landmarks: Landmark[];
  /** Column-major 4x4 like MediaPipe's facialTransformationMatrixes[0].data. */
  matrix: number[];
  /** Stand-in for the eyeBlinkLeft/Right blendshapes average. */
  blinkScore: number;
  aspect: number;
}

/** Physical position (camera frame, cm) of a global screen point on the display. */
export function screenPointToCamera(display: Display, x: number, y: number): Vec3 {
  const lx = x - display.originPt.x;
  const ly = y - display.originPt.y;
  const mm = display.mmPerPt / 10;
  // A point to the viewer's right is on the camera's left: negative x in the raw image.
  return [-(lx - display.widthPt / 2) * mm, ly * mm + display.cameraAboveCm, 0];
}

/** Inverse of screenPointToCamera for points on the display plane. */
export function cameraToScreenPoint(display: Display, p: Vec3): { x: number; y: number } {
  const mm = display.mmPerPt / 10;
  return {
    x: -p[0] / mm + display.widthPt / 2 + display.originPt.x,
    y: (p[1] - display.cameraAboveCm) / mm + display.originPt.y,
  };
}

const deg = Math.PI / 180;

function rotateAbout(dir: Vec3, hDeg: number, vDeg: number): Vec3 {
  // Small rotation of a direction: yaw by hDeg about y, then pitch by vDeg about x.
  return unit3(mulMat3Vec(rotationYPR(hDeg * deg, vDeg * deg, 0), dir));
}

export class SyntheticFace {
  private rand: () => number;

  constructor(
    readonly anatomy: Anatomy = NOMINAL_ANATOMY,
    readonly display: Display = MACBOOK_DISPLAY,
    readonly camera: Camera = WEBCAM_640,
    readonly noise: NoiseModel = TYPICAL_NOISE,
    seed = 1,
  ) {
    this.rand = rng(seed);
  }

  get aspect(): number {
    return this.camera.widthPx / this.camera.heightPx;
  }

  /** Focal length as a fraction of image width. */
  get fx(): number {
    return 1 / (2 * Math.tan((this.camera.hfovDeg * deg) / 2));
  }

  private project(p: Vec3, depthRef: number): Landmark {
    const fx = this.fx;
    return {
      x: 0.5 + (fx * p[0]) / p[2],
      y: 0.5 + (fx * this.aspect * p[1]) / p[2],
      z: (fx * (p[2] - depthRef)) / depthRef,
    };
  }

  render(input: RenderInput): RenderedFrame {
    const a = this.anatomy;
    const n = this.noise;
    const g = () => gaussian(this.rand);
    const head = input.head;
    const rotation = rotationYPR(head.yawDeg * deg, head.pitchDeg * deg, head.rollDeg * deg);
    const toCam = (local: Vec3): Vec3 => add3(head.position, mulMat3Vec(rotation, local));
    const target = screenPointToCamera(this.display, input.gaze.x, input.gaze.y);
    const depthRef = head.position[2];
    const landmarks: Landmark[] = Array.from({ length: MIN_LANDMARKS }, () => ({ x: 0, y: 0, z: 0 }));
    const jitter = (l: Landmark, px: number): Landmark => ({
      x: l.x + (g() * px) / this.camera.widthPx,
      y: l.y + (g() * px) / this.camera.heightPx,
      z: l.z ?? 0,
    });

    const open = a.openness * (1 - Math.max(0, Math.min(1, input.closure))) + 0.02;
    const eyes = [
      { idx: RIGHT_EYE, cx: -a.interocularCm / 2, nasal: 1 },
      { idx: LEFT_EYE, cx: a.interocularCm / 2, nasal: -1 },
    ];
    for (const { idx, cx, nasal } of eyes) {
      const centre = toCam([cx, 0, 0]);
      const front = -a.eyeballRadiusCm * 0.75;
      const outerX = cx + (nasal > 0 ? -1 : 1) * (a.eyeWidthCm / 2);
      const innerX = cx + (nasal > 0 ? 1 : -1) * (a.eyeWidthCm / 2);
      const put = (i: number, local: Vec3, px = n.landmarkPx) => {
        landmarks[i] = jitter(this.project(toCam(local), depthRef), px);
      };
      put(idx.outer, [outerX, 0.05, front * 0.6]);
      put(idx.inner, [innerX, 0.05, front * 0.6]);
      put(idx.upper, [cx, (-open * a.eyeWidthCm) / 2, front]);
      put(idx.lower, [cx, (open * a.eyeWidthCm) / 2, front]);

      // Visual axis points at the target; the optical axis (through the iris) is offset by kappa,
      // nasally. Rotations are applied in the head frame.
      const visualWorld = unit3(sub3(target, centre));
      const visualHead = mulMat3Vec(transposeOf(rotation), visualWorld);
      const opticalHead = rotateAbout(visualHead, nasal * a.kappaHDeg, a.kappaVDeg);
      const irisCentreHead: Vec3 = add3([cx, 0, 0], scale3(opticalHead, a.eyeballRadiusCm));
      // Ring: two unit vectors perpendicular to the optical axis, roughly image-right and image-down.
      const right = unit3(cross(opticalHead, [0, 1, 0]));
      const down = unit3(cross(right, opticalHead));
      const ir = IRIS_DIAMETER_CM / 2;
      const shift: [number, number] = [g() * n.irisPx, g() * n.irisPx];
      // When the lids are closing the iris landmarks become unreliable, as in MediaPipe.
      const blinkPx = input.closure > 0.5 ? 4 : 0;
      const ringLocal: Vec3[] = [
        add3(irisCentreHead, scale3(right, ir)),
        add3(irisCentreHead, scale3(down, -ir)),
        add3(irisCentreHead, scale3(right, -ir)),
        add3(irisCentreHead, scale3(down, ir)),
      ];
      // MediaPipe orders the ring image-right, top, image-left, bottom.
      ringLocal.forEach((p, k) => {
        const l = this.project(toCam(p), depthRef);
        landmarks[idx.iris[k]!] = jitter(
          {
            x: l.x + shift[0] / this.camera.widthPx,
            y: l.y + shift[1] / this.camera.heightPx,
            z: l.z ?? 0,
          },
          n.landmarkPx * 0.5 + blinkPx,
        );
      });
      const centreIdx = idx === RIGHT_EYE ? 468 : 473;
      landmarks[centreIdx] = this.project(toCam(irisCentreHead), depthRef);
    }
    const nose = this.project(toCam([0, 3.6, -3.2]), depthRef);
    landmarks[NOSE_TIP] = jitter(nose, n.landmarkPx);
    // Fill the rest of the mesh with the nose position so nothing is undefined.
    for (let i = 0; i < landmarks.length; i++) {
      const l = landmarks[i]!;
      if (l.x === 0 && l.y === 0) landmarks[i] = { ...nose };
    }

    const noisyRotation = mulMat3(
      rotation,
      rotationYPR(g() * n.poseDeg * deg, g() * n.poseDeg * deg, g() * n.poseDeg * deg),
    );
    const t: Vec3 = [
      head.position[0] + g() * n.poseCm,
      head.position[1] + g() * n.poseCm,
      head.position[2] + g() * n.poseCm * 2,
    ];
    return {
      landmarks,
      matrix: toGlMatrix(noisyRotation, t),
      blinkScore: Math.max(0, Math.min(1, input.closure * 0.95 + Math.abs(g()) * 0.03)),
      aspect: this.aspect,
    };
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function transposeOf(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Column-major OpenGL-convention matrix (y up, z towards the viewer), like MediaPipe's. */
export function toGlMatrix(rotation: Mat3, t: Vec3): number[] {
  const f = [1, -1, -1];
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) out[col * 4 + row] = rotation[row * 3 + col]! * f[row]! * f[col]!;
  out[12] = t[0] * f[0]!;
  out[13] = t[1] * f[1]!;
  out[14] = t[2] * f[2]!;
  out[15] = 1;
  return out;
}
