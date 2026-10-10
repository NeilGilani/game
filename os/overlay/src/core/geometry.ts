/** Rectangle maths in global screen points (origin top-left of the main display). */

import type { ScreenRect, Target } from "../contracts";

export interface Point {
  x: number;
  y: number;
}

export function rect(x: number, y: number, width: number, height: number): ScreenRect {
  return { x, y, width, height };
}

export function right(r: ScreenRect): number {
  return r.x + r.width;
}

export function bottom(r: ScreenRect): number {
  return r.y + r.height;
}

export function center(r: ScreenRect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function area(r: ScreenRect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function contains(r: ScreenRect, p: Point): boolean {
  return p.x >= r.x && p.x <= right(r) && p.y >= r.y && p.y <= bottom(r);
}

export function distanceToRect(p: Point, r: ScreenRect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - right(r));
  const dy = Math.max(r.y - p.y, 0, p.y - bottom(r));
  return Math.hypot(dx, dy);
}

export function intersection(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(right(a), right(b)) - x;
  const h = Math.min(bottom(a), bottom(b)) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

export function overlapArea(a: ScreenRect, b: ScreenRect): number {
  const i = intersection(a, b);
  return i ? area(i) : 0;
}

export function inflate(r: ScreenRect, by: number): ScreenRect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** Smallest gap between two rectangles (0 when they touch or overlap). */
export function gapBetween(a: ScreenRect, b: ScreenRect): number {
  const dx = Math.max(b.x - right(a), a.x - right(b), 0);
  const dy = Math.max(b.y - bottom(a), a.y - bottom(b), 0);
  return Math.hypot(dx, dy);
}

/**
 * The target containing the point (smallest wins when nested, e.g. a button inside a cell), or
 * else the nearest target within `snapPt`. Returns null when nothing is close enough.
 */
export function pickTarget<T extends { rect: ScreenRect }>(
  p: Point,
  targets: readonly T[],
  snapPt: number,
): T | null {
  let best: { t: T; d: number; a: number } | null = null;
  for (const t of targets) {
    const d = distanceToRect(p, t.rect);
    if (d > snapPt) continue;
    const a = area(t.rect);
    if (!best || d < best.d || (d === best.d && a < best.a)) best = { t, d, a };
  }
  return best?.t ?? null;
}

/** Targets within `radius` of the point, nearest first. */
export function targetsNear(p: Point, targets: readonly Target[], radius: number): Target[] {
  return targets
    .map((t) => ({ t, d: distanceToRect(p, t.rect) }))
    .filter((e) => e.d <= radius)
    .sort((a, b) => a.d - b.d || area(a.t.rect) - area(b.t.rect))
    .map((e) => e.t);
}

/** Reading order: rows top to bottom (rows grouped by vertical overlap), left to right inside a row. */
export function readingOrder<T extends { rect: ScreenRect }>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const rows: T[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const first = row?.[0];
    const midY = item.rect.y + item.rect.height / 2;
    if (row && first && midY >= first.rect.y && midY <= bottom(first.rect)) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.rect.x - b.rect.x));
}
