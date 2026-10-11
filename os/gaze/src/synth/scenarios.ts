/**
 * Synthetic sessions with known ground truth: head motion, fixations and saccades, natural
 * blinks, deliberate long blinks, reading, and target selection. Deterministic per seed.
 * All of it is simulated; see face.ts for what the model leaves out.
 */

import { type Vec3, gaussian, rng } from "../linalg";
import type { HeadState, RenderedFrame, SyntheticFace } from "./face";

export type HeadMotionKind = "still" | "natural" | "moving";

export interface HeadMotionOptions {
  kind: HeadMotionKind;
  /** Resting head position (cm, camera frame). */
  base?: Vec3;
  seed?: number;
}

const AMPLITUDE: Record<HeadMotionKind, { cm: number; deg: number }> = {
  still: { cm: 0.4, deg: 0.8 },
  natural: { cm: 2, deg: 4 },
  moving: { cm: 5, deg: 10 },
};

/** Anything that says where the head is at a given time (ms). */
export interface HeadSource {
  at(tMs: number): HeadState;
}

/** Slow, smooth head movement: a sum of low-frequency sinusoids with random phases. */
export class HeadMotion implements HeadSource {
  private phases: number[];
  private readonly amp: { cm: number; deg: number };
  readonly base: Vec3;

  constructor(options: HeadMotionOptions) {
    const r = rng((options.seed ?? 1) * 104729 + 7);
    this.phases = Array.from({ length: 12 }, () => r() * Math.PI * 2);
    this.amp = AMPLITUDE[options.kind];
    this.base = options.base ?? [0, 14, 60];
  }

  at(tMs: number): HeadState {
    const t = tMs / 1000;
    const w = (i: number, f: number) => Math.sin(2 * Math.PI * f * t + this.phases[i]!);
    const slow = (i: number) => 0.6 * w(i, 0.05) + 0.4 * w(i + 6, 0.13);
    return {
      position: [
        this.base[0] + this.amp.cm * slow(0),
        this.base[1] + this.amp.cm * 0.6 * slow(1),
        this.base[2] + this.amp.cm * 1.5 * slow(2),
      ],
      yawDeg: this.amp.deg * slow(3),
      pitchDeg: this.amp.deg * 0.7 * slow(4),
      rollDeg: this.amp.deg * 0.4 * slow(5),
    };
  }
}

export interface Fixation {
  x: number;
  y: number;
  durationMs: number;
}

export interface GazeTruth {
  x: number;
  y: number;
  fixation: boolean;
  /** 0 open .. 1 closed. */
  closure: number;
}

export interface GazeScriptOptions {
  /** Natural blinks (about every 4 s, 150 ms) unless false. */
  naturalBlinks?: boolean;
  /** Fixational jitter (drift and microsaccades), points RMS. */
  fixationJitterPt?: number;
  /** Deliberate closures: [startMs, durationMs]. */
  closures?: [number, number][];
  seed?: number;
}

/** Turns a list of fixations into gaze truth over time, with saccades between them. */
export class GazeScript {
  private starts: number[] = [];
  private rand: () => number;
  private blinkTimes: number[] = [];
  readonly totalMs: number;

  constructor(
    readonly fixations: readonly Fixation[],
    private readonly options: GazeScriptOptions = {},
  ) {
    this.rand = rng((options.seed ?? 1) * 7573 + 3);
    let t = 0;
    for (const f of fixations) {
      this.starts.push(t);
      t += f.durationMs;
    }
    this.totalMs = t;
    if (options.naturalBlinks !== false) {
      for (let b = 1500 + this.rand() * 3000; b < t; b += 2500 + this.rand() * 3500) this.blinkTimes.push(b);
    }
  }

  /** Saccade duration grows with amplitude (about 20 ms + 2 ms per degree; 1 degree ~ 40 pt here). */
  private static saccadeMs(distPt: number): number {
    return Math.min(90, 20 + (2 * distPt) / 40);
  }

  at(tMs: number): GazeTruth {
    let i = this.starts.length - 1;
    while (i > 0 && this.starts[i]! > tMs) i--;
    const f = this.fixations[Math.max(0, i)]!;
    const prev = i > 0 ? this.fixations[i - 1]! : f;
    const since = tMs - this.starts[Math.max(0, i)]!;
    const dist = Math.hypot(f.x - prev.x, f.y - prev.y);
    const sacc = i > 0 ? GazeScript.saccadeMs(dist) : 0;
    let x = f.x;
    let y = f.y;
    let fixation = true;
    if (since < sacc) {
      const s = since / sacc;
      const ease = s * s * (3 - 2 * s);
      x = prev.x + (f.x - prev.x) * ease;
      y = prev.y + (f.y - prev.y) * ease;
      fixation = false;
    } else {
      const j = this.options.fixationJitterPt ?? 6;
      x += gaussian(this.rand) * j;
      y += gaussian(this.rand) * j;
    }
    let closure = 0;
    for (const b of this.blinkTimes) {
      const d = tMs - b;
      if (d >= 0 && d < 150) closure = Math.max(closure, d < 50 ? d / 50 : d < 100 ? 1 : (150 - d) / 50);
    }
    for (const [start, len] of this.options.closures ?? []) {
      const d = tMs - start;
      if (d >= 0 && d < len) closure = Math.max(closure, Math.min(1, d / 60, (len - d) / 60));
    }
    return { x, y, fixation, closure };
  }
}

export interface SimFrame {
  t: number;
  frame: RenderedFrame;
  truth: GazeTruth;
  head: HeadState;
}

/** Frames at about `fps` with timing jitter, like a real camera loop. */
export function* simulate(
  face: SyntheticFace,
  script: GazeScript,
  head: HeadSource,
  options: { fps?: number; startMs?: number; seed?: number } = {},
): Generator<SimFrame> {
  const fps = options.fps ?? 30;
  const r = rng((options.seed ?? 1) * 31 + 5);
  const start = options.startMs ?? 0;
  for (let local = 0; local < script.totalMs; local += (1000 / fps) * (0.9 + 0.2 * r())) {
    const t = start + local;
    const truth = script.at(local);
    const h = head.at(t);
    yield {
      t,
      frame: face.render({ gaze: { x: truth.x, y: truth.y }, head: h, closure: truth.closure }),
      truth,
      head: h,
    };
  }
}

/** A page of text being read: lines of fixations left to right, with return sweeps and regressions. */
export function readingFixations(
  bounds: { x: number; y: number; width: number; height: number },
  options: { lines?: number; seed?: number } = {},
): Fixation[] {
  const r = rng((options.seed ?? 1) * 1299709 + 11);
  const lines = options.lines ?? 12;
  const out: Fixation[] = [];
  const left = bounds.x + bounds.width * 0.12;
  const right = bounds.x + bounds.width * 0.88;
  for (let line = 0; line < lines; line++) {
    const y = bounds.y + bounds.height * (0.15 + (0.7 * line) / Math.max(1, lines - 1));
    let x = left + r() * 20;
    while (x < right) {
      out.push({ x, y, durationMs: 180 + r() * 140 });
      if (r() < 0.1 && x > left + 120) {
        out.push({ x: x - 60 - r() * 60, y, durationMs: 160 + r() * 100 }); // regression
      }
      x += 70 + r() * 60; // about 7 to 9 characters
    }
  }
  return out;
}

/**
 * A change of posture after calibration, on top of the person's ordinary small movements:
 * translation (cm, camera frame: x towards the camera's right, which is the person's left; y down;
 * z away from the camera) and rotation (degrees, as HeadState: positive yaw turns the face to the
 * person's right, positive pitch tilts it down).
 */
export interface PostureChange {
  d?: [number, number, number];
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
}

/** Head motion scenarios: how real people move during a session. All simulated. */
export const POSTURES = {
  /** Leans in towards the screen (12 cm closer). */
  leanIn: { d: [0, 0, -12] },
  /** Leans back in the chair (12 cm further). */
  leanBack: { d: [0, 0, 12] },
  /** Slumps: the head drops 5 cm and tilts down a little. */
  slouch: { d: [0, 5, 0], pitchDeg: 6 },
  /** Turns the head towards something to one side of the screen. */
  turnRight: { yawDeg: 10 },
  turnLeft: { yawDeg: -10 },
  /** Chin up / chin down. */
  chinUp: { pitchDeg: -8 },
  chinDown: { pitchDeg: 8 },
  /** Shifts sideways in the chair (6 cm to the person's right). */
  shiftRight: { d: [-6, 0, 0] },
} as const satisfies Record<string, PostureChange>;

export type PostureName = keyof typeof POSTURES;

/**
 * Ordinary head motion with a posture change eased in from `fromMs` over `rampMs` (a person
 * settling into a new position, or slowly sliding down in the chair when rampMs is minutes long).
 */
export class PostureShift implements HeadSource {
  constructor(
    private readonly base: HeadSource,
    private readonly change: PostureChange,
    private readonly fromMs: number,
    private readonly rampMs = 1500,
  ) {}

  at(tMs: number): HeadState {
    const h = this.base.at(tMs);
    const u = Math.max(0, Math.min(1, (tMs - this.fromMs) / Math.max(1, this.rampMs)));
    const k = u * u * (3 - 2 * u);
    const d = this.change.d ?? [0, 0, 0];
    return {
      position: [h.position[0] + k * d[0], h.position[1] + k * d[1], h.position[2] + k * d[2]],
      yawDeg: h.yawDeg + k * (this.change.yawDeg ?? 0),
      pitchDeg: h.pitchDeg + k * (this.change.pitchDeg ?? 0),
      rollDeg: h.rollDeg + k * (this.change.rollDeg ?? 0),
    };
  }
}
