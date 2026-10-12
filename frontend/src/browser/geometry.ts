/** Rectangles for AGENCY Browser's eye-choosing layouts (labels, the lens). Pure. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const right = (r: Rect) => r.x + r.width;
export const bottom = (r: Rect) => r.y + r.height;

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < right(b) + gap && b.x < right(a) + gap && a.y < bottom(b) + gap && b.y < bottom(a) + gap;
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < right(r) && p.y >= r.y && p.y < bottom(r);
}

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Moves `r` inside `box` (keeping its size; a rect bigger than the box sticks to the top-left). */
export function clampInto(r: Rect, box: Rect): Rect {
  const x = Math.max(box.x, Math.min(r.x, right(box) - r.width));
  const y = Math.max(box.y, Math.min(r.y, bottom(box) - r.height));
  return { ...r, x, y };
}

/** Distance from a point to a rectangle (0 inside). */
export function distanceTo(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - right(r));
  const dy = Math.max(r.y - p.y, 0, p.y - bottom(r));
  return Math.hypot(dx, dy);
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(right(a), right(b)) - x;
  const h = Math.min(bottom(a), bottom(b)) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}
