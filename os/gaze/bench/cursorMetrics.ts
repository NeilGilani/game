/**
 * How the DRAWN cursor behaves: jitter while fixating, lag after a saccade, accuracy, and movement
 * during blinks. Shared by bench/cursor.bench.ts (simulated frames in Node) and
 * frontend/e2e/eyes.spec.ts (the real cursor element in Chromium, simulated person).
 *
 * Input is the cursor as drawn, sampled once per display frame, plus the ground truth: where the
 * eyes landed and when. All units are pixels (or points) and milliseconds.
 *
 * Definitions:
 * - jitter: RMS distance of the cursor from its own mean, from 250 ms after the eyes land until
 *   they leave (fixations with at least 300 ms in that window). What the person sees as shake.
 * - step: RMS of the cursor's movement from one drawn frame to the next in the same window.
 * - lag: time from the eyes landing (after a jump of at least 200 px) until the cursor first comes
 *   within 50 px of where it settles (its mean from 400 ms after landing to the end; fixations of
 *   700 ms or more). Median over saccades.
 * - accuracy: distance from the cursor's mean in the jitter window to the point looked at.
 * - blink: largest distance the cursor moves from where it was when the eyes started to close,
 *   until 150 ms after they open again (includes any real jump the eyes made around the blink).
 * - closed: the same, only while the eyes are closing or closed.
 */

export interface CursorSample {
  t: number;
  x: number;
  y: number;
}

export interface LookedAt {
  x: number;
  y: number;
  /** When the eyes landed on it. */
  start: number;
  /** When they left. */
  end: number;
}

export interface Interval {
  start: number;
  end: number;
}

export interface CursorMetrics {
  jitterPx: number;
  stepPx: number;
  lagMs: number;
  accuracyPx: number;
  blinkMovePx: number;
  closedMovePx: number;
  fixations: number;
  saccades: number;
  blinks: number;
  /** Drawn frames per second in the samples. */
  drawnFps: number;
}

export const SETTLE_RADIUS_PX = 50;
const JITTER_FROM_MS = 250;
const SETTLED_FROM_MS = 400;
const MIN_SACCADE_PX = 200;

const mean = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const median = (v: readonly number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
};

function centre(samples: readonly CursorSample[]): { x: number; y: number } {
  return { x: mean(samples.map((s) => s.x)), y: mean(samples.map((s) => s.y)) };
}

export function cursorMetrics(
  cursor: readonly CursorSample[],
  looks: readonly LookedAt[],
  blinks: readonly Interval[] = [],
): CursorMetrics {
  const jitter: number[] = [];
  const step: number[] = [];
  const accuracy: number[] = [];
  const lag: number[] = [];
  // Blinks spoil both measures; leave out fixations that contain one.
  const blinkIn = (a: number, b: number) => blinks.some((k) => k.start < b && k.end + 150 > a);
  looks.forEach((f, i) => {
    if (blinkIn(f.start, f.end)) return;
    const win = cursor.filter((s) => s.t >= f.start + JITTER_FROM_MS && s.t < f.end);
    if (win.length >= 5 && f.end - f.start - JITTER_FROM_MS >= 300) {
      const c = centre(win);
      jitter.push(Math.sqrt(mean(win.map((s) => (s.x - c.x) ** 2 + (s.y - c.y) ** 2))));
      accuracy.push(Math.hypot(c.x - f.x, c.y - f.y));
      const d: number[] = [];
      for (let k = 1; k < win.length; k++)
        d.push((win[k]!.x - win[k - 1]!.x) ** 2 + (win[k]!.y - win[k - 1]!.y) ** 2);
      step.push(Math.sqrt(mean(d)));
    }
    const prev = looks[i - 1];
    if (!prev || Math.hypot(f.x - prev.x, f.y - prev.y) < MIN_SACCADE_PX || f.end - f.start < 700) return;
    const settled = cursor.filter((s) => s.t >= f.start + SETTLED_FROM_MS && s.t < f.end);
    if (settled.length < 5) return;
    const c = centre(settled);
    const hit = cursor.find(
      (s) => s.t >= f.start && s.t < f.end && Math.hypot(s.x - c.x, s.y - c.y) <= SETTLE_RADIUS_PX,
    );
    lag.push(hit ? hit.t - f.start : f.end - f.start);
  });
  const moves: number[] = [];
  const closed: number[] = [];
  for (const b of blinks) {
    const before = [...cursor].reverse().find((s) => s.t <= b.start);
    if (!before) continue;
    const during = cursor.filter((s) => s.t > b.start && s.t <= b.end + 150);
    moves.push(Math.max(0, ...during.map((s) => Math.hypot(s.x - before.x, s.y - before.y))));
    const shut = cursor.filter((s) => s.t > b.start && s.t <= b.end);
    closed.push(Math.max(0, ...shut.map((s) => Math.hypot(s.x - before.x, s.y - before.y))));
  }
  const span = cursor.length > 1 ? cursor[cursor.length - 1]!.t - cursor[0]!.t : 0;
  return {
    jitterPx: mean(jitter),
    stepPx: mean(step),
    lagMs: median(lag),
    accuracyPx: mean(accuracy),
    blinkMovePx: mean(moves),
    closedMovePx: mean(closed),
    fixations: jitter.length,
    saccades: lag.length,
    blinks: moves.length,
    drawnFps: span > 0 ? ((cursor.length - 1) * 1000) / span : 0,
  };
}

/**
 * The cursor as the web app drew it before the rebuild: on every camera frame InputLayer set the
 * cursor's transform to the engine's point, and CSS glided there with
 * `transition: transform 110ms cubic-bezier(0.2, 0.8, 0.2, 1)`. A new value interrupts the running
 * transition and starts a new one from wherever the cursor is drawn at that moment, as browsers do.
 */
export class CssTransitionCursor {
  private from: { x: number; y: number } | null = null;
  private to: { x: number; y: number } | null = null;
  private startT = 0;

  constructor(
    private readonly durationMs = 110,
    private readonly ease = cubicBezier(0.2, 0.8, 0.2, 1),
  ) {}

  set(t: number, x: number, y: number): void {
    if (this.to && this.to.x === x && this.to.y === y) return; // same value: no new transition
    this.from = this.to ? this.at(t) : { x, y };
    this.to = { x, y };
    this.startT = t;
  }

  at(t: number): { x: number; y: number } {
    if (!this.to || !this.from) return { x: NaN, y: NaN };
    const s = Math.max(0, Math.min(1, (t - this.startT) / this.durationMs));
    const e = this.ease(s);
    return { x: this.from.x + (this.to.x - this.from.x) * e, y: this.from.y + (this.to.y - this.from.y) * e };
  }

  get started(): boolean {
    return this.to !== null;
  }
}

/** CSS cubic-bezier timing function (x1, y1, x2, y2), solved for y at a given x by Newton/bisection. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const b = (a1: number, a2: number, s: number) =>
    3 * a1 * s * (1 - s) ** 2 + 3 * a2 * s ** 2 * (1 - s) + s ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let s = x;
    for (let i = 0; i < 40; i++) {
      const v = b(x1, x2, s);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return b(y1, y2, s);
  };
}
