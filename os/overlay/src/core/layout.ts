/**
 * Where the overlay draws its own buttons. All layout is pure so hit-testing, tests and drawing agree.
 *
 * Rules (PLAN.md accessibility bar): every button at least 96 x 96 pt with at least 24 pt between
 * buttons; the protected rail never moves while the person looks at it; panels open away from what the
 * person is looking at, so the overlay never covers it.
 */

import type { ScreenRect } from "../contracts";
import { bottom, overlapArea, right } from "./geometry";

export const MIN_TARGET = 96;
export const GAP = 24;
export const EDGE = 16;

export type RailSide = "left" | "right";

/** Vertical column of equal buttons on one edge of the display, centred vertically. */
export function layoutRail(
  display: ScreenRect,
  side: RailSide,
  count: number,
  size = MIN_TARGET,
): ScreenRect[] {
  // Buttons never shrink below `size`: on a display too short for the column it starts at the top edge
  // and overflows rather than making targets too small (displays under ~720 pt tall are not supported).
  const total = count * size + (count - 1) * GAP;
  const top = display.y + Math.max(EDGE, (display.height - total) / 2);
  const x = side === "left" ? display.x + EDGE : right(display) - EDGE - size;
  return Array.from({ length: count }, (_, i) => ({
    x,
    y: top + i * (size + GAP),
    width: size,
    height: size,
  }));
}

export function boundsOf(rects: readonly ScreenRect[]): ScreenRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map(right)) - x,
    height: Math.max(...rects.map(bottom)) - y,
  };
}

/** The display area left for panels once the rail and an edge margin are taken out. */
export function usableArea(display: ScreenRect, rail: ScreenRect, side: RailSide): ScreenRect {
  const margin = EDGE;
  const railW = rail.width + GAP + EDGE;
  return {
    x: display.x + margin + (side === "left" ? railW : 0),
    y: display.y + margin,
    width: display.width - 2 * margin - railW,
    height: display.height - 2 * margin,
  };
}

/**
 * Position a panel of the given size inside `area` so that it covers as little as possible of the rects
 * the person is paying attention to. Candidates are the four sides and the centre; ties go to the
 * candidate farthest from the attention rects, then to the bottom (the conventional keyboard place).
 */
export function placePanel(
  area: ScreenRect,
  size: { width: number; height: number },
  avoid: readonly ScreenRect[],
): ScreenRect {
  const w = Math.min(size.width, area.width);
  const h = Math.min(size.height, area.height);
  const cx = area.x + (area.width - w) / 2;
  const cy = area.y + (area.height - h) / 2;
  const clampX = (x: number) => Math.max(area.x, Math.min(right(area) - w, x));
  const clampY = (y: number) => Math.max(area.y, Math.min(bottom(area) - h, y));
  const candidates: ScreenRect[] = [
    { x: cx, y: bottom(area) - h, width: w, height: h },
    { x: cx, y: area.y, width: w, height: h },
    { x: area.x, y: cy, width: w, height: h },
    { x: right(area) - w, y: cy, width: w, height: h },
    { x: cx, y: cy, width: w, height: h },
  ];
  // Flush against each side of each attention rect, for when it sits in the middle of the screen.
  for (const a of avoid) {
    const ay = clampY(a.y + a.height / 2 - h / 2);
    const ax = clampX(a.x + a.width / 2 - w / 2);
    candidates.push(
      { x: clampX(right(a) + GAP), y: ay, width: w, height: h },
      { x: clampX(a.x - GAP - w), y: ay, width: w, height: h },
      { x: ax, y: clampY(bottom(a) + GAP), width: w, height: h },
      { x: ax, y: clampY(a.y - GAP - h), width: w, height: h },
    );
  }
  const score = (r: ScreenRect) => avoid.reduce((s, a) => s + overlapArea(r, a), 0);
  const centreDistance = (r: ScreenRect) =>
    avoid.reduce(
      (s, a) =>
        s + Math.hypot(r.x + r.width / 2 - (a.x + a.width / 2), r.y + r.height / 2 - (a.y + a.height / 2)),
      0,
    );
  let best = candidates[0] as ScreenRect;
  for (const c of candidates.slice(1)) {
    const d = score(c) - score(best);
    if (d < 0 || (d === 0 && centreDistance(c) > centreDistance(best) + 1)) best = c;
  }
  return best;
}

export interface GridSpec {
  columns: number;
  rows: number;
  cell: { width: number; height: number };
}

/** Rects for a grid of buttons laid out inside `box` from its top-left, with GAP between cells. */
export function layoutGrid(box: ScreenRect, spec: GridSpec, count: number): ScreenRect[] {
  const out: ScreenRect[] = [];
  for (let i = 0; i < Math.min(count, spec.columns * spec.rows); i++) {
    const col = i % spec.columns;
    const row = Math.floor(i / spec.columns);
    out.push({
      x: box.x + col * (spec.cell.width + GAP),
      y: box.y + row * (spec.cell.height + GAP),
      width: spec.cell.width,
      height: spec.cell.height,
    });
  }
  return out;
}

export function gridSize(spec: GridSpec): { width: number; height: number } {
  return {
    width: spec.columns * spec.cell.width + (spec.columns - 1) * GAP,
    height: spec.rows * spec.cell.height + (spec.rows - 1) * GAP,
  };
}

/** Split a list into pages of `size` (paging, not scrolling, for gaze users). */
export function paginate<T>(
  items: readonly T[],
  size: number,
  page: number,
): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.max(0, Math.min(page, pages - 1));
  return { items: items.slice(p * size, p * size + size), page: p, pages };
}
