/**
 * Head movement after the eye scan: how much the gaze estimate shifts when the head turns, tilts
 * or moves, learned per person, and what to tell the person when they have moved too far.
 *
 * Two layers handle head movement. The features do most of it: eye positions are measured with the
 * head's rotation and the camera's viewing angle undone (landmarks.ts), and the landmark model
 * reads where each eye's ray meets the screen (features.ts). What they leave is a small offset that
 * grows with the change of pose and differs from person to person (the eye's real size and visual
 * axis are not the nominal ones). This module measures that offset's sensitivity:
 *
 *   offset (points) = J . (pose - scan pose),   pose = [yaw deg, pitch deg, x cm, y cm, distance cm]
 *
 * J starts as a Bayesian estimate from the scan itself: the scan's held-out errors (each stretch of
 * the path predicted by a model fitted without it), averaged per stretch, regressed on how the pose
 * differed from the scan's median, with a prior that says "no change" unless the data say otherwise.
 * The estimate is kept only if it predicts held-out stretches better than "no change" by 15 %. A
 * person who held still gives the data nothing to go on, and J stays at zero; one who moved during
 * the scan may give enough. Continuous recalibration keeps refining J from everyday
 * selections and touch-ups made in other positions (continuous.ts), starting from this estimate.
 *
 * Tests: tests/head.test.ts (simulated people whose heads move after the scan).
 */

import { solve } from "../linalg";
import type { GazeInput } from "./features";
import { type ModelConfig, type Sample, fitModel, predictModel } from "./model";

/** Pose terms, in this order: yaw and pitch (degrees), x, y and distance (cm, camera frame). */
export const HEAD_TERMS = ["yaw", "pitch", "tx", "ty", "tz"] as const;
export type HeadTerm = (typeof HEAD_TERMS)[number];

export type HeadPosition = Record<HeadTerm, number>;

/** Prior spread of each sensitivity (points per degree or cm): what's plausible before any data. */
export const HEAD_PRIOR_STD: readonly number[] = [6, 6, 8, 8, 4];

/** Pose changes are clamped to this range before J is applied, so a glitch can't throw the pointer. */
const DELTA_LIMIT: readonly number[] = [25, 20, 12, 12, 20];

/** The head offset never moves the estimate further than this (points). */
const MAX_OFFSET_PT = 220;

export interface HeadModel {
  version: 1;
  /** The pose during the scan (medians of the scan's frames). */
  ref: HeadPosition;
  /** How much the pose varied during the scan (robust SD per term). */
  spread: number[];
  /** Points of gaze offset per unit change of each term, for x and y. */
  jx: number[];
  jy: number[];
  /** Posterior precision of J (5x5, row-major, per point² of noise): how sure the scan was, per term. */
  precision: number[];
  /** Typical held-out error of a stretch of the scan (points), the noise the estimate allowed for. */
  noisePt: number;
}

export function poseOf(input: Pick<GazeInput, HeadTerm>): HeadPosition {
  return { yaw: input.yaw, pitch: input.pitch, tx: input.tx, ty: input.ty, tz: input.tz };
}

/** Pose change from the scan, clamped to a plausible range; zeros when there is no reference. */
export function headDelta(model: HeadModel | null | undefined, input: Pick<GazeInput, HeadTerm>): number[] {
  if (!model) return [0, 0, 0, 0, 0];
  return HEAD_TERMS.map((k, i) => {
    const d = input[k] - model.ref[k];
    const lim = DELTA_LIMIT[i]!;
    return Number.isFinite(d) ? Math.max(-lim, Math.min(lim, d)) : 0;
  });
}

/** The offset J . delta (points), capped. */
export function headOffset(jx: readonly number[], jy: readonly number[], delta: readonly number[]) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < delta.length; i++) {
    x += (jx[i] ?? 0) * delta[i]!;
    y += (jy[i] ?? 0) * delta[i]!;
  }
  const len = Math.hypot(x, y);
  if (len > MAX_OFFSET_PT) {
    x *= MAX_OFFSET_PT / len;
    y *= MAX_OFFSET_PT / len;
  }
  return { x, y };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Leave-one-group-out residuals (target - prediction) of a model configuration on its own samples. */
function heldOutResiduals(samples: readonly Sample[], config: ModelConfig) {
  const groups = [...new Set(samples.map((s) => s.group))];
  const out: { group: string; rx: number; ry: number; input: GazeInput }[] = [];
  for (const g of groups) {
    const model = fitModel(
      samples.filter((s) => s.group !== g),
      config,
    );
    if (!model) continue;
    for (const s of samples) {
      if (s.group !== g) continue;
      const p = predictModel(model, s.input);
      if (p) out.push({ group: g, rx: s.x - p.x, ry: s.y - p.y, input: s.input });
    }
  }
  return out;
}

/**
 * The head model for a scan: its reference pose, and J estimated from the scan's held-out errors.
 * `samples` are the samples the landmark model was fitted on (aggregated), `config` its configuration.
 * Null when the camera gave no metric head pose (no transformation matrix).
 */
export function fitHeadModel(samples: readonly Sample[], config: ModelConfig): HeadModel | null {
  if (samples.length < 8 || !samples.every((s) => s.input.normalized)) return null;
  const ref = Object.fromEntries(
    HEAD_TERMS.map((k) => [k, median(samples.map((s) => s.input[k]))]),
  ) as HeadPosition;
  const spread = HEAD_TERMS.map((k) => {
    const dev = samples.map((s) => Math.abs(s.input[k] - ref[k]));
    return 1.4826 * median(dev);
  });
  const model: HeadModel = {
    version: 1,
    ref,
    spread,
    jx: [0, 0, 0, 0, 0],
    jy: [0, 0, 0, 0, 0],
    precision: priorPrecision(),
    noisePt: 60,
  };

  // One observation per stretch of the path: frames within a stretch share their errors.
  const residuals = heldOutResiduals(samples, config);
  const byGroup = new Map<string, typeof residuals>();
  for (const r of residuals) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  const rows: { z: number[]; rx: number; ry: number }[] = [];
  for (const list of byGroup.values()) {
    const z = HEAD_TERMS.map((k) => list.reduce((s, r) => s + r.input[k], 0) / list.length - ref[k]);
    rows.push({
      z,
      rx: list.reduce((s, r) => s + r.rx, 0) / list.length,
      ry: list.reduce((s, r) => s + r.ry, 0) / list.length,
    });
  }
  if (rows.length < 6) return model;
  const mx = rows.reduce((s, r) => s + r.rx, 0) / rows.length;
  const my = rows.reduce((s, r) => s + r.ry, 0) / rows.length;
  const variance =
    rows.reduce((s, r) => s + (r.rx - mx) ** 2 + (r.ry - my) ** 2, 0) / (2 * Math.max(1, rows.length - 1));
  // Neighbouring stretches share slow errors (the head drifts with the path): count them as half as informative.
  const sigma = Math.SQRT2 * Math.max(10, Math.sqrt(variance));
  const obs = rows.map((r) => ({ z: r.z, rx: r.rx - mx, ry: r.ry - my, weight: 1 }));
  const prior = { jx: model.jx, jy: model.jy, precision: model.precision };
  // Keep the estimate only if it predicts stretches it didn't see better than "no change" does:
  // a few seconds of small, slow head movement can't always tell a head effect from noise.
  let withJ = 0;
  let without = 0;
  for (let i = 0; i < obs.length; i++) {
    const fit = bayesUpdate(
      prior,
      obs.filter((_, j) => j !== i),
      sigma,
    );
    if (!fit) return { ...model, noisePt: sigma };
    const o = obs[i]!;
    const p = headOffset(fit.jx, fit.jy, o.z);
    withJ += (o.rx - p.x) ** 2 + (o.ry - p.y) ** 2;
    without += o.rx ** 2 + o.ry ** 2;
  }
  const posterior = bayesUpdate(prior, obs, sigma);
  if (!posterior || withJ > 0.85 * without) return { ...model, noisePt: sigma };
  return { ...model, ...posterior, noisePt: sigma };
}

/** Prior precision of J: diag(1 / prior std²). */
export function priorPrecision(): number[] {
  const p = new Array<number>(25).fill(0);
  HEAD_PRIOR_STD.forEach((s, i) => (p[i * 5 + i] = 1 / (s * s)));
  return p;
}

/**
 * Bayesian linear update of J with observations of the offset (rx, ry) at pose changes z, noise
 * sigma points. Returns the posterior mean and precision, or null if the system is degenerate.
 */
export function bayesUpdate(
  prior: { jx: readonly number[]; jy: readonly number[]; precision: readonly number[] },
  observations: readonly { z: readonly number[]; rx: number; ry: number; weight: number }[],
  sigma: number,
): { jx: number[]; jy: number[]; precision: number[] } | null {
  const n = HEAD_TERMS.length;
  const p = [...prior.precision];
  // Prior information vector: P m.
  const bx = new Array<number>(n).fill(0);
  const by = new Array<number>(n).fill(0);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      bx[a]! += p[a * n + b]! * prior.jx[b]!;
      by[a]! += p[a * n + b]! * prior.jy[b]!;
    }
  }
  const s2 = sigma * sigma;
  for (const o of observations) {
    const w = o.weight / s2;
    for (let a = 0; a < n; a++) {
      bx[a]! += w * o.z[a]! * o.rx;
      by[a]! += w * o.z[a]! * o.ry;
      for (let b = 0; b < n; b++) p[a * n + b]! += w * o.z[a]! * o.z[b]!;
    }
  }
  const m = Array.from({ length: n }, (_, a) => p.slice(a * n, a * n + n));
  try {
    return { jx: solve(m, bx), jy: solve(m, by), precision: p };
  } catch {
    return null;
  }
}

// --- Posture: telling the person when they have moved far from where they were during the scan ---

export type PostureIssue =
  | "lean-back"
  | "come-closer"
  | "sit-up"
  | "sit-lower"
  | "move-right"
  | "move-left"
  | "face-screen"
  | "chin-up"
  | "chin-down";

/** Plain words, one short instruction each. "Your" left and right: the person's own. */
export const POSTURE_MESSAGES: Record<PostureIssue, string> = {
  "lean-back": "Lean back a little.",
  "come-closer": "Come a little closer to the screen.",
  "sit-up": "Sit up a little.",
  "sit-lower": "Sit a little lower.",
  "move-right": "Move a little to your right.",
  "move-left": "Move a little to your left.",
  "face-screen": "Turn your head back towards the screen.",
  "chin-up": "Lift your chin a little.",
  "chin-down": "Lower your chin a little.",
};

export interface PostureOptions {
  /** Distance change, as a fraction of the scan's distance. */
  distance: number;
  /** Up/down and sideways movement, cm. */
  verticalCm: number;
  sidewaysCm: number;
  /** Head turn and tilt, degrees. */
  yawDeg: number;
  pitchDeg: number;
  /** The pose must stay out of range this long before the person is told (ms). */
  holdMs: number;
  /** And back within range (thresholds x `clearFraction`) this long before the message goes. */
  clearMs: number;
  clearFraction: number;
}

/**
 * Set where the simulated error climbs past about 1.4x its value at the scan's pose (tests/head.test.ts,
 * still-head scan, 4 simulated people, scan pose 65 pt): head turned 18 degrees (~90 pt; 15: 87, 25:
 * 119), chin up 14 (12: 82), leaning back a quarter of the distance (15 cm: ~100 pt). Leaning in,
 * sliding down and moving sideways cost less (18 cm closer: 61; 11 cm lower: 74; 12 cm sideways: 82),
 * so those limits are about where the face starts to leave a laptop camera's view. Ordinary sway
 * (a few cm, a few degrees) stays well inside, and nothing is said.
 */
export const DEFAULT_POSTURE: PostureOptions = {
  distance: 0.25,
  verticalCm: 9,
  sidewaysCm: 10,
  yawDeg: 18,
  pitchDeg: 14,
  holdMs: 1500,
  clearMs: 1000,
  clearFraction: 0.75,
};

/**
 * How far a pose is from the scan's, as a multiple of each threshold, and the instruction that would
 * undo the largest excess. Camera frame: x grows towards the camera's right, which is the person's
 * left; y grows downwards. MediaPipe's pitch grows as the head tilts down (its yaw sign doesn't matter
 * here).
 */
export function postureExcess(
  pose: HeadPosition,
  ref: HeadPosition,
  o: PostureOptions = DEFAULT_POSTURE,
): { issue: PostureIssue; excess: number } | null {
  const dz = (pose.tz - ref.tz) / Math.max(ref.tz, 1);
  const dy = pose.ty - ref.ty;
  const dx = pose.tx - ref.tx;
  const dyaw = pose.yaw - ref.yaw;
  const dpitch = pose.pitch - ref.pitch;
  const candidates: { issue: PostureIssue; excess: number }[] = [
    { issue: dz < 0 ? "lean-back" : "come-closer", excess: Math.abs(dz) / o.distance },
    { issue: dy > 0 ? "sit-up" : "sit-lower", excess: Math.abs(dy) / o.verticalCm },
    { issue: dx > 0 ? "move-right" : "move-left", excess: Math.abs(dx) / o.sidewaysCm },
    { issue: "face-screen", excess: Math.abs(dyaw) / o.yawDeg },
    { issue: dpitch > 0 ? "chin-up" : "chin-down", excess: Math.abs(dpitch) / o.pitchDeg },
  ];
  const top = candidates.reduce((a, b) => (b.excess > a.excess ? b : a));
  return Number.isFinite(top.excess) ? top : null;
}

/**
 * Watches the pose and says (once, in plain words) when the person has moved far from where they
 * were during the scan, and when they're back. Short moves (a glance at a notification, a cough)
 * pass without a word; the median over the last second is what counts.
 */
export class PostureMonitor {
  private o: PostureOptions;
  private recent: { t: number; pose: HeadPosition }[] = [];
  private outSince: number | null = null;
  private inSince: number | null = null;
  private shown: PostureIssue | null = null;

  constructor(options: Partial<PostureOptions> = {}) {
    this.o = { ...DEFAULT_POSTURE, ...options };
  }

  get current(): PostureIssue | null {
    return this.shown;
  }

  reset(): void {
    this.recent = [];
    this.outSince = null;
    this.inSince = null;
    this.shown = null;
  }

  /** Returns the issue now shown when it changed (null: the message can go), else undefined. */
  update(t: number, pose: HeadPosition | null, ref: HeadPosition | null): PostureIssue | null | undefined {
    if (!ref) {
      if (this.shown === null) return undefined;
      this.reset();
      return null;
    }
    if (pose) this.recent.push({ t, pose });
    while (this.recent.length && t - this.recent[0]!.t > 1000) this.recent.shift();
    if (this.recent.length < 5) return undefined;
    const smooth = Object.fromEntries(
      HEAD_TERMS.map((k) => [k, median(this.recent.map((r) => r.pose[k]))]),
    ) as HeadPosition;
    const ex = postureExcess(smooth, ref, this.o);
    if (!ex) return undefined;
    const before = this.shown;
    if (ex.excess >= 1) {
      this.inSince = null;
      this.outSince ??= t;
      if (t - this.outSince >= this.o.holdMs && this.shown !== ex.issue) {
        // Once a message is up, switch to another only when that one is clearly the bigger problem.
        if (this.shown === null || ex.excess >= 1.2) this.shown = ex.issue;
      }
    } else {
      this.outSince = null;
      if (this.shown !== null && ex.excess <= this.o.clearFraction) {
        this.inSince ??= t;
        if (t - this.inSince >= this.o.clearMs) this.shown = null;
      } else {
        this.inSince = null;
      }
    }
    return this.shown !== before ? this.shown : undefined;
  }
}
