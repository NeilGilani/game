/**
 * Feature extraction from MediaPipe Face Landmarker output (478 landmarks with iris).
 *
 * Indices are checked against the package's own connection tables in
 * tests/landmarks.test.ts (FaceLandmarker.FACE_LANDMARKS_{LEFT,RIGHT}_{EYE,IRIS}), so they
 * are not guesses. "Left"/"right" are the person's own left and right.
 *
 * Webcam gaze estimation is approximate. These features (where the iris sits inside the
 * eye opening, plus head pose) are what calibration maps to screen positions; nothing here
 * claims clinical or eye-tracker precision.
 */

import { type Mat3, type Vec3, mulMat3Vec, transpose3 } from "./linalg";

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface EyeIndices {
  outer: number;
  inner: number;
  upper: number;
  lower: number;
  iris: readonly number[];
}

export const RIGHT_EYE: EyeIndices = {
  outer: 33,
  inner: 133,
  upper: 159,
  lower: 145,
  iris: [469, 470, 471, 472],
};
export const LEFT_EYE: EyeIndices = {
  outer: 263,
  inner: 362,
  upper: 386,
  lower: 374,
  iris: [474, 475, 476, 477],
};
export const NOSE_TIP = 1;
export const MIN_LANDMARKS = 478;

export interface EyeFeatures {
  /** Iris position along the eye's corner-to-corner axis, 0 = image-left corner, 1 = image-right corner. */
  h: number;
  /** Iris offset perpendicular to that axis (image-down positive), in eye widths. */
  v: number;
  /** Lid opening divided by eye width. Drops sharply during a blink. */
  openness: number;
  /** Eye width in isotropic image units. */
  width: number;
  irisCenter: Point;
}

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface GazeFeatures {
  h: number;
  v: number;
  left: EyeFeatures;
  right: EyeFeatures;
  openness: number;
  pose: HeadPose;
  /** Distance between eye centres as a fraction of image width: a proxy for how close the face is. */
  faceScale: number;
  /** Nose tip in normalised image coordinates (0..1). */
  nose: Point;
  /**
   * Eye features measured after undoing the head's rotation (from the facial transformation
   * matrix): where the iris sits in the eye with the head turned back to face the camera.
   * h and v here are centred (0 = iris in the middle of the eye opening).
   */
  leftN: EyeFeatures | null;
  rightN: EyeFeatures | null;
  /** Head rotation in camera coordinates (x right, y down, z away from the camera), when known. */
  rotation: Mat3 | null;
  /** Head position in centimetres in the same frame (MediaPipe's metric estimate), when known. */
  translationCm: Vec3 | null;
  /** Mean iris diameter as a fraction of image width (about 11.7 mm on a real eye). */
  irisDiameter: number;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const len = (a: Point): number => Math.hypot(a.x, a.y);

function iso(l: Landmark, aspect: number): Point {
  // Normalised landmark x is a fraction of image width, y of height. Scaling x by the
  // aspect ratio makes distances comparable in both directions.
  return { x: l.x * aspect, y: l.y };
}

export function eyeFeatures(
  landmarks: readonly Landmark[],
  eye: EyeIndices,
  aspect: number,
): EyeFeatures | null {
  const get = (i: number): Point | null => {
    const l = landmarks[i];
    return l ? iso(l, aspect) : null;
  };
  const a = get(eye.outer);
  const b = get(eye.inner);
  const up = get(eye.upper);
  const low = get(eye.lower);
  const ring = eye.iris.map(get);
  if (!a || !b || !up || !low || ring.some((p) => p === null)) return null;
  const pts = ring as Point[];
  const irisCenter = {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
  // Orient the axis left-to-right in the image so both eyes agree on direction.
  const left = a.x <= b.x ? a : b;
  const right = a.x <= b.x ? b : a;
  const axis = sub(right, left);
  const width = len(axis);
  if (width < 1e-6) return null;
  const unit = { x: axis.x / width, y: axis.y / width };
  const normal = { x: -unit.y, y: unit.x };
  const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const h = dot(sub(irisCenter, left), unit) / width;
  const v = dot(sub(irisCenter, mid), normal) / width;
  const openness = len(sub(low, up)) / width;
  return { h, v, openness, width, irisCenter };
}

/** Yaw/pitch/roll in degrees from MediaPipe's 4x4 facial transformation matrix (column-major). */
export function headPoseFromMatrix(data: readonly number[]): HeadPose | null {
  if (data.length < 16) return null;
  const r = (row: number, col: number): number => data[col * 4 + row] ?? 0;
  const sy = Math.hypot(r(0, 0), r(1, 0));
  const deg = 180 / Math.PI;
  const pitch = Math.atan2(r(2, 1), r(2, 2)) * deg;
  const yaw = Math.atan2(-r(2, 0), sy) * deg;
  const roll = Math.atan2(r(1, 0), r(0, 0)) * deg;
  return { yaw, pitch, roll };
}

/** Rough head pose from landmarks alone, used if the transformation matrix is unavailable. */
export function headPoseFromLandmarks(landmarks: readonly Landmark[], aspect: number): HeadPose | null {
  const nose = landmarks[NOSE_TIP];
  const r = landmarks[RIGHT_EYE.outer];
  const l = landmarks[LEFT_EYE.outer];
  if (!nose || !r || !l) return null;
  const n = iso(nose, aspect);
  const a = iso(r, aspect);
  const b = iso(l, aspect);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const span = len(sub(b, a)) || 1;
  return {
    yaw: ((n.x - mid.x) / span) * 60,
    pitch: ((n.y - mid.y) / span - 0.55) * 60,
    roll: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  };
}

/** MediaPipe's matrix is OpenGL-style (y up, z towards the viewer). C converts to our camera frame. */
const FLIP: Vec3 = [1, -1, -1];

/**
 * Head rotation and translation in camera coordinates (x right in the image, y down, z away from
 * the camera) from MediaPipe's 4x4 facial transformation matrix (column-major, canonical face to
 * camera, centimetres).
 */
export function headTransformFromMatrix(
  data: readonly number[],
): { rotation: Mat3; translationCm: Vec3 } | null {
  if (data.length < 16) return null;
  const r = (row: number, col: number): number => (data[col * 4 + row] ?? 0) * FLIP[row]! * FLIP[col]!;
  const rotation: Mat3 = [r(0, 0), r(0, 1), r(0, 2), r(1, 0), r(1, 1), r(1, 2), r(2, 0), r(2, 1), r(2, 2)];
  if (rotation.some((v) => !Number.isFinite(v))) return null;
  const t: Vec3 = [(data[12] ?? 0) * FLIP[0]!, (data[13] ?? 0) * FLIP[1]!, (data[14] ?? 0) * FLIP[2]!];
  return { rotation, translationCm: t };
}

/**
 * Eye features with the head rotation undone. Landmarks are lifted to 3D (x and z are in image-width
 * units, so both are scaled by the aspect ratio to match y), rotated back by the inverse head
 * rotation around the eye's own centre, and measured in that frontal frame.
 */
export function normalizedEyeFeatures(
  landmarks: readonly Landmark[],
  eye: EyeIndices,
  aspect: number,
  rotation: Mat3,
): EyeFeatures | null {
  const inv = transpose3(rotation);
  const raw = (i: number): Vec3 | null => {
    const l = landmarks[i];
    return l ? [l.x * aspect, l.y, (l.z ?? 0) * aspect] : null;
  };
  const a = raw(eye.outer);
  const b = raw(eye.inner);
  const up = raw(eye.upper);
  const low = raw(eye.lower);
  const ring = eye.iris.map(raw);
  if (!a || !b || !up || !low || ring.some((p) => p === null)) return null;
  const centre: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const frontal = (p: Vec3): Point => {
    const q = mulMat3Vec(inv, [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]);
    return { x: q[0], y: q[1] };
  };
  const fa = frontal(a);
  const fb = frontal(b);
  const pts = (ring as Vec3[]).map(frontal);
  const iris = {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
  const left = fa.x <= fb.x ? fa : fb;
  const right = fa.x <= fb.x ? fb : fa;
  const axis = sub(right, left);
  const width = len(axis);
  if (width < 1e-6) return null;
  const unit = { x: axis.x / width, y: axis.y / width };
  const normal = { x: -unit.y, y: unit.x };
  const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const h = dot(sub(iris, mid), unit) / width;
  const v = dot(sub(iris, mid), normal) / width;
  const openness = len(sub(frontal(low), frontal(up))) / width;
  return { h, v, openness, width, irisCenter: iris };
}

/** Iris diameter (fraction of image width) from the four ring landmarks of one eye. */
export function irisDiameter(landmarks: readonly Landmark[], eye: EyeIndices, aspect: number): number | null {
  const p = eye.iris.map((i) => landmarks[i]);
  if (p.some((l) => !l)) return null;
  const [r, t, l, b] = p as Landmark[];
  const d1 = Math.hypot((r!.x - l!.x) * aspect, r!.y - l!.y);
  const d2 = Math.hypot((t!.x - b!.x) * aspect, t!.y - b!.y);
  return (d1 + d2) / 2 / aspect;
}

export function extractFeatures(
  landmarks: readonly Landmark[] | undefined,
  aspect: number,
  matrix?: readonly number[],
): GazeFeatures | null {
  if (!landmarks || landmarks.length < MIN_LANDMARKS) return null;
  const right = eyeFeatures(landmarks, RIGHT_EYE, aspect);
  const left = eyeFeatures(landmarks, LEFT_EYE, aspect);
  const nose = landmarks[NOSE_TIP];
  if (!right || !left || !nose) return null;
  const pose = (matrix && headPoseFromMatrix(matrix)) || headPoseFromLandmarks(landmarks, aspect);
  if (!pose) return null;
  const eyeDistance = len(sub(left.irisCenter, right.irisCenter)) / aspect;
  const transform = matrix ? headTransformFromMatrix(matrix) : null;
  const rotation = transform?.rotation ?? null;
  const dl = irisDiameter(landmarks, LEFT_EYE, aspect);
  const dr = irisDiameter(landmarks, RIGHT_EYE, aspect);
  return {
    leftN: rotation ? normalizedEyeFeatures(landmarks, LEFT_EYE, aspect, rotation) : null,
    rightN: rotation ? normalizedEyeFeatures(landmarks, RIGHT_EYE, aspect, rotation) : null,
    rotation,
    translationCm: transform?.translationCm ?? null,
    irisDiameter: dl !== null && dr !== null ? (dl + dr) / 2 : (dl ?? dr ?? 0),
    h: (left.h + right.h) / 2,
    v: (left.v + right.v) / 2,
    left,
    right,
    openness: (left.openness + right.openness) / 2,
    pose,
    faceScale: eyeDistance,
    nose: { x: nose.x, y: nose.y },
  };
}

/** Blink score 0..1 from blendshapes (eyeBlinkLeft/eyeBlinkRight), if present. */
export function blinkFromBlendshapes(
  categories: readonly { categoryName: string; score: number }[] | undefined,
): number | null {
  if (!categories || categories.length === 0) return null;
  let left: number | null = null;
  let right: number | null = null;
  for (const c of categories) {
    if (c.categoryName === "eyeBlinkLeft") left = c.score;
    if (c.categoryName === "eyeBlinkRight") right = c.score;
  }
  if (left === null || right === null) return null;
  return (left + right) / 2;
}
