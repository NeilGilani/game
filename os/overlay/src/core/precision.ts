/**
 * Precision help for small or crowded targets.
 *
 * Webcam gaze is off by tens of points, so a button smaller than the error circle, or several buttons
 * inside it, can't be hit reliably by snapping alone. Instead of guessing (and pressing the wrong thing,
 * which the person may not be able to undo), the overlay asks "which one?" with big labelled choices,
 * or, when there are too many, shows a zoomed map of the area.
 *
 * Instance 2's gaze engine is meant to publish these decisions (os/gaze); until its contract lands
 * the overlay uses this local decider. See INTEGRATION_REQUEST.md.
 */

import type { ScreenRect, Target } from "../contracts";
import { contains, distanceToRect, targetsNear, type Point } from "./geometry";

export type PrecisionDecision =
  /** Snap to this target (or nothing). */
  | { kind: "direct"; target: Target | null }
  /** Several plausible targets: offer them as big labelled buttons. */
  | { kind: "pick"; candidates: Target[]; anchor: ScreenRect }
  /** Too many to list: zoom this region so they can be told apart. */
  | { kind: "magnify"; region: ScreenRect; zoom: number; candidates: Target[] };

export interface PrecisionConfig {
  /** Expected gaze error radius in points (from calibration quality). */
  errorPt: number;
  /** A target at least this big on its shortest side is comfortable to hit directly. */
  comfortablePt: number;
  /** Most candidates the picker lists before switching to the magnifier. */
  maxPick: number;
}

export const DEFAULT_PRECISION: PrecisionConfig = { errorPt: 60, comfortablePt: 96, maxPick: 6 };

/** Error radius to use for a given calibration error: generous, never below 30 pt. */
export function errorRadiusFor(meanErrorPt: number | null | undefined): number {
  if (meanErrorPt === null || meanErrorPt === undefined || !Number.isFinite(meanErrorPt)) {
    return DEFAULT_PRECISION.errorPt;
  }
  return Math.max(30, Math.round(meanErrorPt * 1.5));
}

function minSide(r: ScreenRect): number {
  return Math.min(r.width, r.height);
}

export function decidePrecision(
  gaze: Point,
  targets: readonly Target[],
  config: Partial<PrecisionConfig> = {},
): PrecisionDecision {
  const c = { ...DEFAULT_PRECISION, ...config };
  const near = targetsNear(gaze, targets, c.errorPt);
  if (near.length === 0) return { kind: "direct", target: null };
  if (near.length === 1) return { kind: "direct", target: near[0] ?? null };

  // Gaze well inside a big target, with the error circle not reaching anything else: no ambiguity.
  const inside = near.find((t) => contains(t.rect, gaze) && minSide(t.rect) >= c.comfortablePt);
  if (inside) {
    const competing = near.filter((t) => t !== inside && !nested(t.rect, inside.rect));
    const clear = competing.every((t) => distanceToRect(gaze, t.rect) > c.errorPt / 2);
    if (clear) return { kind: "direct", target: inside };
  }

  const anchor = errorCircleRect(gaze, c.errorPt);
  if (near.length <= c.maxPick) return { kind: "pick", candidates: near, anchor };
  const region = errorCircleRect(gaze, c.errorPt * 2);
  const zoom = Math.max(2, Math.min(4, Math.round((c.comfortablePt * 1.5) / smallestSide(near))));
  return { kind: "magnify", region, zoom, candidates: near };
}

function nested(inner: ScreenRect, outer: ScreenRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function smallestSide(targets: readonly Target[]): number {
  return Math.max(1, Math.min(...targets.map((t) => minSide(t.rect))));
}

function errorCircleRect(p: Point, r: number): ScreenRect {
  return { x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r };
}
