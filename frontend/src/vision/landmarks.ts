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
  return {
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
