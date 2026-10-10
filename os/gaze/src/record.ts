/**
 * Record and replay. A recording stores face LANDMARKS ONLY (by default just the ones the
 * pipeline reads: eye corners, lids, iris rings, nose tip), never video or images, and only when
 * the person has explicitly opted in. Recordings stay on the Mac unless the person exports one.
 * They let us reproduce a session exactly, build regression fixtures and benchmark changes.
 */

import { LEFT_EYE, type Landmark, MIN_LANDMARKS, NOSE_TIP, RIGHT_EYE } from "./landmarks";
import type { FaceFrame } from "./providers/types";

/** The landmarks the pipeline uses. A recording of these can't redraw a face. */
export const PIPELINE_INDICES: readonly number[] = [
  ...new Set([
    NOSE_TIP,
    RIGHT_EYE.outer,
    RIGHT_EYE.inner,
    RIGHT_EYE.upper,
    RIGHT_EYE.lower,
    ...RIGHT_EYE.iris,
    LEFT_EYE.outer,
    LEFT_EYE.inner,
    LEFT_EYE.upper,
    LEFT_EYE.lower,
    ...LEFT_EYE.iris,
    468,
    473,
  ]),
].sort((a, b) => a - b);

export interface RecordedFrame {
  t: number;
  captureT?: number;
  /** x, y, z per recorded index, rounded; null when no face was found. */
  l: number[] | null;
  m?: number[] | null;
  b?: number | null;
}

export interface Label {
  /** What the person was asked to look at, in global screen points, from t0 to t1 (ms). */
  t0: number;
  t1: number;
  x: number;
  y: number;
  kind: "calibration" | "validation" | "selection" | "reading" | "blink-pattern" | "other";
}

export interface Recording {
  format: "agency-gaze-recording";
  version: 1;
  createdAt: string;
  /** "person": they opted in on this Mac. "synthetic": generated, no person involved. */
  origin: "person" | "synthetic";
  note: string;
  aspect: number;
  indices: number[];
  frames: RecordedFrame[];
  labels: Label[];
  /** Display the labels refer to, global points. */
  display?: { x: number; y: number; width: number; height: number };
}

export class ConsentRequiredError extends Error {}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export class Recorder {
  private frames: RecordedFrame[] = [];
  private labels: Label[] = [];
  private aspect = 4 / 3;
  private readonly indices: number[];

  /**
   * @param consent must be literally true: the person chose to record, on this Mac, knowing
   *   that landmark positions (not video) are stored.
   */
  constructor(
    consent: boolean,
    private readonly options: { origin?: Recording["origin"]; note?: string; allLandmarks?: boolean } = {},
  ) {
    if (consent !== true) throw new ConsentRequiredError("Recording needs the person's explicit consent.");
    this.indices = options.allLandmarks
      ? Array.from({ length: MIN_LANDMARKS }, (_, i) => i)
      : [...PIPELINE_INDICES];
  }

  add(frame: FaceFrame): void {
    this.aspect = frame.aspect;
    const l = frame.landmarks;
    this.frames.push({
      t: round(frame.t, 2),
      ...(frame.captureT !== undefined ? { captureT: round(frame.captureT, 2) } : {}),
      l: l
        ? this.indices.flatMap((i) => {
            const p = l[i];
            return p ? [round(p.x, 5), round(p.y, 5), round(p.z ?? 0, 5)] : [0, 0, 0];
          })
        : null,
      m: frame.matrix ? frame.matrix.map((v) => round(v, 5)) : null,
      b: frame.blink === undefined || frame.blink === null ? null : round(frame.blink, 3),
    });
  }

  label(label: Label): void {
    this.labels.push(label);
  }

  get size(): number {
    return this.frames.length;
  }

  finish(display?: Recording["display"]): Recording {
    return {
      format: "agency-gaze-recording",
      version: 1,
      createdAt: new Date().toISOString(),
      origin: this.options.origin ?? "person",
      note: this.options.note ?? "",
      aspect: this.aspect,
      indices: this.indices,
      frames: this.frames,
      labels: this.labels,
      ...(display ? { display } : {}),
    };
  }
}

export function isRecording(value: unknown): value is Recording {
  const r = value as Partial<Recording> | null;
  return (
    !!r &&
    r.format === "agency-gaze-recording" &&
    r.version === 1 &&
    Array.isArray(r.indices) &&
    Array.isArray(r.frames) &&
    Array.isArray(r.labels) &&
    typeof r.aspect === "number"
  );
}

/** Rebuild the full 478-landmark array MediaPipe would give (unrecorded points get the nose). */
export function frameToFace(rec: Recording, f: RecordedFrame): FaceFrame {
  let landmarks: Landmark[] | null = null;
  if (f.l) {
    const flat = f.l;
    const nosePos = rec.indices.indexOf(NOSE_TIP);
    const fill: Landmark =
      nosePos >= 0
        ? { x: flat[nosePos * 3]!, y: flat[nosePos * 3 + 1]!, z: flat[nosePos * 3 + 2]! }
        : { x: 0.5, y: 0.5, z: 0 };
    landmarks = Array.from({ length: MIN_LANDMARKS }, () => ({ ...fill }));
    rec.indices.forEach((idx, k) => {
      landmarks![idx] = { x: flat[k * 3]!, y: flat[k * 3 + 1]!, z: flat[k * 3 + 2]! };
    });
  }
  return {
    t: f.t,
    ...(f.captureT !== undefined ? { captureT: f.captureT } : {}),
    landmarks,
    matrix: f.m ?? null,
    blink: f.b ?? null,
    aspect: rec.aspect,
  };
}

/** The label active at time t, if any. */
export function labelAt(rec: Recording, t: number): Label | null {
  return rec.labels.find((l) => t >= l.t0 && t <= l.t1) ?? null;
}
