/** Hit-testing for dwell targets, with "snap" so a slightly-off estimate still lands. */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TargetRect {
  /** Context prior from the screen and task (1 = neutral), already clamped and safety-checked. */
  prior?: number;
  id: string;
  rect: Rect;
}

export function distanceToRect(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/**
 * The target containing the point, or else the nearest target within `snapPx`.
 * Ties (point inside overlapping targets) go to the smallest target.
 */
export function findTarget(
  x: number,
  y: number,
  targets: readonly TargetRect[],
  snapPx: number,
): string | null {
  let best: { id: string; distance: number; area: number } | null = null;
  for (const t of targets) {
    const d = distanceToRect(x, y, t.rect);
    if (d > snapPx) continue;
    const area = (t.rect.right - t.rect.left) * (t.rect.bottom - t.rect.top);
    if (!best || d < best.distance || (d === best.distance && area < best.area)) {
      best = { id: t.id, distance: d, area };
    }
  }
  return best?.id ?? null;
}

/** Clamp a point to the viewport so an extrapolated estimate stays on screen. */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) };
}
