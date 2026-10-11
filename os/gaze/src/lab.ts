/**
 * The Gaze lab's measurements: how accurate and how steady eye control is for THIS person with THIS
 * camera, from a 9-dot test, and which filter and lock settings suit them. Pure functions over
 * numbers the app already has (pointer coordinates, the engine's error radius); no images, no
 * landmarks, nothing about the face. The result can be exported as anonymous metrics.
 *
 * Definitions (the same as BENCHMARKS.md, so lab numbers and simulated numbers compare):
 * - accuracy: distance from the mean filtered pointer during a dot (from settleMs after it appeared)
 *   to the dot. raw accuracy: the same for the unsmoothed estimate.
 * - jitter: RMS of the filtered pointer around that mean (what the person sees as shake). raw jitter:
 *   the same before smoothing.
 * - measured error radius: the 86th percentile of every filtered sample's distance to its dot, which
 *   is what the engine's error radius (about 2 sigma) claims to be. Comparing the two says whether
 *   the engine's own confidence can be trusted for this person.
 * - settle: time from a dot appearing until the filtered pointer is within 100 px of where it settles.
 */

import { DEFAULT_FIXATION, type FixationOptions, FixationSmoother } from "./fixation";

export interface LabDot {
  id: number;
  /** Viewport px. */
  x: number;
  y: number;
}

/** The 9 dots at 10 / 50 / 90 % of the viewport, in reading order. */
export function nineDots(width: number, height: number): LabDot[] {
  const f = [0.1, 0.5, 0.9];
  const dots: LabDot[] = [];
  for (const fy of f)
    for (const fx of f) dots.push({ id: dots.length, x: Math.round(fx * width), y: Math.round(fy * height) });
  return dots;
}

export interface LabSample {
  /** ms */
  t: number;
  /** Which dot was showing. */
  dot: number;
  /** When that dot appeared (ms). */
  dotStart: number;
  /** The pointer the person sees (filtered), viewport px; null when there was none. */
  point: { x: number; y: number } | null;
  /** The estimate before smoothing, viewport px. */
  raw: { x: number; y: number } | null;
  confidence: number;
  /** The engine's error radius (px, about 2 sigma). */
  errorRadius: number;
}

export interface DotMetrics {
  dot: number;
  x: number;
  y: number;
  samples: number;
  /** Share of this dot's frames (after settling) with a usable estimate (confidence >= 0.5). */
  usable: number;
  accuracyPx: number;
  rawAccuracyPx: number;
  jitterPx: number;
  rawJitterPx: number;
  settleMs: number | null;
}

export interface LabSummary {
  dotsMeasured: number;
  accuracyPx: number;
  /** Worst-but-one dot's accuracy (with 9 dots, about the 90th percentile). */
  accuracyP90Px: number;
  rawAccuracyPx: number;
  jitterPx: number;
  rawJitterPx: number;
  usable: number;
  measuredErrorRadiusPx: number;
  reportedErrorRadiusPx: number;
  settleMs: number | null;
}

export interface LabMetrics {
  dots: DotMetrics[];
  summary: LabSummary;
}

export interface MeasureOptions {
  /** Ignore the first part of each dot (eyes travelling, pointer settling), ms. */
  settleMs: number;
  /** "Settled" means within this distance of where the pointer ends up (px). */
  settleRadiusPx: number;
}

export const DEFAULT_MEASURE: MeasureOptions = { settleMs: 800, settleRadiusPx: 100 };

const mean = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const median = (v: readonly number[]) => quantile(v, 0.5);
export function quantile(v: readonly number[], p: number): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, p * (s.length - 1)));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

function spread(pts: readonly { x: number; y: number }[]): { x: number; y: number; rms: number } {
  const x = mean(pts.map((p) => p.x));
  const y = mean(pts.map((p) => p.y));
  const rms = Math.sqrt(mean(pts.map((p) => (p.x - x) ** 2 + (p.y - y) ** 2)));
  return { x, y, rms };
}

/** Accuracy, jitter and settling per dot and overall. Dots with fewer than 5 usable samples are skipped. */
export function measure(
  samples: readonly LabSample[],
  dots: readonly LabDot[],
  options: Partial<MeasureOptions> = {},
): LabMetrics {
  const o = { ...DEFAULT_MEASURE, ...options };
  const out: DotMetrics[] = [];
  const errors: number[] = [];
  const reported: number[] = [];
  for (const dot of dots) {
    const all = samples.filter((s) => s.dot === dot.id);
    const late = all.filter((s) => s.t - s.dotStart >= o.settleMs);
    const good = late.filter((s) => s.point && s.confidence >= 0.5);
    if (good.length < 5) continue;
    const pts = good.map((s) => s.point!);
    const c = spread(pts);
    const raws = good.filter((s) => s.raw).map((s) => s.raw!);
    const r = raws.length >= 5 ? spread(raws) : null;
    for (const p of pts) errors.push(Math.hypot(p.x - dot.x, p.y - dot.y));
    for (const s of good) reported.push(s.errorRadius);
    // Settling: from the dot's start, the first sample within settleRadiusPx of the settled mean.
    const first = all.find(
      (s) => s.point && Math.hypot(s.point.x - c.x, s.point.y - c.y) <= o.settleRadiusPx,
    );
    out.push({
      dot: dot.id,
      x: dot.x,
      y: dot.y,
      samples: good.length,
      usable: late.length ? good.length / late.length : 0,
      accuracyPx: Math.hypot(c.x - dot.x, c.y - dot.y),
      rawAccuracyPx: r ? Math.hypot(r.x - dot.x, r.y - dot.y) : NaN,
      jitterPx: c.rms,
      rawJitterPx: r ? r.rms : NaN,
      settleMs: first ? first.t - first.dotStart : null,
    });
  }
  const acc = out.map((d) => d.accuracyPx);
  const settles = out.map((d) => d.settleMs).filter((v): v is number => v !== null);
  return {
    dots: out,
    summary: {
      dotsMeasured: out.length,
      accuracyPx: mean(acc),
      accuracyP90Px: quantile(acc, 0.9),
      rawAccuracyPx: mean(out.map((d) => d.rawAccuracyPx).filter(Number.isFinite)),
      jitterPx: median(out.map((d) => d.jitterPx)),
      rawJitterPx: median(out.map((d) => d.rawJitterPx).filter(Number.isFinite)),
      usable: mean(out.map((d) => d.usable)),
      measuredErrorRadiusPx: quantile(errors, 0.86),
      reportedErrorRadiusPx: median(reported),
      settleMs: settles.length ? median(settles) : null,
    },
  };
}

// --- Filter tuning on the person's own data ---------------------------------------------------

export type FilterSettings = Pick<FixationOptions, "z" | "minK" | "windowMs">;

export const DEFAULT_FILTER: FilterSettings = {
  z: DEFAULT_FIXATION.z,
  minK: DEFAULT_FIXATION.minK,
  windowMs: DEFAULT_FIXATION.windowMs,
};

/** The settings the lab tries: around the defaults, from twitchier to calmer. */
export function filterCandidates(): FilterSettings[] {
  const out: FilterSettings[] = [];
  for (const z of [2.5, 3.3, 4.2])
    for (const minK of [1, 2, 3]) for (const windowMs of [600, 1000, 1500]) out.push({ z, minK, windowMs });
  return out;
}

/**
 * Run the recorded raw estimates through a smoother with these settings, as the engine would have,
 * and return the samples as if it had. Viewport px are used as points; the smoother only needs a
 * consistent unit (its 1-degree floor is converted at the default viewing distance).
 */
export function replayFilter(samples: readonly LabSample[], settings: FilterSettings): LabSample[] {
  const smoother = new FixationSmoother(settings);
  return samples.map((s) => {
    if (!s.raw) return { ...s, point: null };
    const p = smoother.update(s.t, s.raw.x, s.raw.y);
    return { ...s, point: { x: p.x, y: p.y } };
  });
}

export interface FilterTrial {
  settings: FilterSettings;
  metrics: LabSummary;
  /** Lower is better: jitter, plus a penalty for settling slower than the default (see tuneFilter). */
  score: number;
}

/**
 * Replay every candidate on the person's recording and rank them. The score is jitter (what they see
 * as shake) plus 0.2 px per ms of extra settling time over the default settings, so a calmer filter
 * only wins if it doesn't make the pointer slow to follow the eyes. Accuracy barely depends on the
 * filter (it averages the same estimates), so it isn't part of the score.
 */
export function tuneFilter(
  samples: readonly LabSample[],
  dots: readonly LabDot[],
  options: Partial<MeasureOptions> = {},
): FilterTrial[] {
  const base = measure(replayFilter(samples, DEFAULT_FILTER), dots, options).summary;
  const baseSettle = base.settleMs ?? 0;
  const trials = filterCandidates().map((settings) => {
    const m = measure(replayFilter(samples, settings), dots, options).summary;
    const slower = Math.max(0, (m.settleMs ?? baseSettle) - baseSettle);
    const score = Number.isFinite(m.jitterPx) ? m.jitterPx + 0.2 * slower : Infinity;
    return { settings, metrics: m, score };
  });
  return trials.sort((a, b) => a.score - b.score);
}

// --- Lock settings from the measurements ------------------------------------------------------

export interface LockRecommendation {
  /** Reach beyond a target's edge (preferences target_snap_px). */
  target_snap_px: number;
  /** Steadiness the dwell needs (preferences dwell_stability_px). */
  dwell_stability_px: number;
  /** Why, in one plain sentence each. */
  reasons: string[];
}

const round4 = (v: number) => Math.round(v / 4) * 4;

/**
 * Snap: a look at the middle of AGENCY's smallest target (96 px) lands within the measured error
 * radius of it, so the estimate can be up to (error radius - 48) px outside the target's edge. Kept
 * within 24..96 px: below 24 a slight miss isn't caught, above 96 neighbours would be reached.
 * Steadiness: the dwell needs the pointer within stabilityPx over 300 ms; filtered jitter J (RMS)
 * keeps nearly every 300 ms window within about 3 J. Kept within 30..150 px.
 */
export function recommendLock(summary: LabSummary): LockRecommendation | null {
  if (
    summary.dotsMeasured < 5 ||
    !Number.isFinite(summary.measuredErrorRadiusPx) ||
    !Number.isFinite(summary.jitterPx)
  )
    return null;
  const snap = Math.max(24, Math.min(96, round4(summary.measuredErrorRadiusPx - 48)));
  const stability = Math.max(30, Math.min(150, round4(3 * summary.jitterPx)));
  return {
    target_snap_px: snap,
    dwell_stability_px: stability,
    reasons: [
      `Your pointer lands within ${Math.round(summary.measuredErrorRadiusPx)} px of where you look 86% of the time, so targets reach ${snap} px beyond their edge.`,
      `It shakes about ${Math.round(summary.jitterPx)} px while you hold still, so a dwell allows ${stability} px of movement.`,
    ],
  };
}

// --- Anonymous export ---------------------------------------------------------------------------

export interface LabExport {
  kind: "agency-gaze-lab";
  version: 1;
  /** Local day only (YYYY-MM-DD). */
  date: string;
  viewport: { width: number; height: number };
  camera: { width: number; height: number; fps: number } | null;
  mode: "gaze" | "head";
  filter: FilterSettings;
  summary: LabSummary;
  dots: Omit<DotMetrics, "x" | "y">[];
  tuning?: { best: FilterSettings; bestScore: number; defaultScore: number } | null;
}

/**
 * Numbers only: no images, no landmarks, no raw samples, no timestamps beyond the day, no device
 * names. Dot positions are left out (they follow from the viewport and the 10/50/90 % grid).
 */
export function exportMetrics(input: {
  date: Date;
  viewport: { width: number; height: number };
  camera: { width: number; height: number; fps: number } | null;
  mode: "gaze" | "head";
  filter: FilterSettings;
  metrics: LabMetrics;
  tuning?: FilterTrial[] | null;
}): LabExport {
  const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
  const summary = Object.fromEntries(
    Object.entries(input.metrics.summary).map(([k, v]) => [k, typeof v === "number" ? r1(v) : v]),
  ) as unknown as LabSummary;
  const best = input.tuning?.[0];
  const def = input.tuning?.find(
    (t) =>
      t.settings.z === DEFAULT_FILTER.z &&
      t.settings.minK === DEFAULT_FILTER.minK &&
      t.settings.windowMs === DEFAULT_FILTER.windowMs,
  );
  return {
    kind: "agency-gaze-lab",
    version: 1,
    date: [
      input.date.getFullYear(),
      String(input.date.getMonth() + 1).padStart(2, "0"),
      String(input.date.getDate()).padStart(2, "0"),
    ].join("-"),
    viewport: { width: Math.round(input.viewport.width), height: Math.round(input.viewport.height) },
    camera: input.camera
      ? { width: input.camera.width, height: input.camera.height, fps: Math.round(input.camera.fps) }
      : null,
    mode: input.mode,
    filter: input.filter,
    summary,
    dots: input.metrics.dots.map(({ x: _x, y: _y, ...d }) => ({
      ...d,
      accuracyPx: r1(d.accuracyPx),
      rawAccuracyPx: r1(d.rawAccuracyPx),
      jitterPx: r1(d.jitterPx),
      rawJitterPx: r1(d.rawJitterPx),
      usable: r1(d.usable * 100) / 100,
    })),
    tuning:
      best && def ? { best: best.settings, bestScore: r1(best.score), defaultScore: r1(def.score) } : null,
  };
}
