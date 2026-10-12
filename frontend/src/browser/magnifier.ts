/**
 * "Zoom to choose": the person looks at a part of the page; a big, isolated button there is chosen directly, and
 * anywhere else a lens opens with that part of the page magnified (2 to 4 times), so small or crowded links become
 * big enough to choose with the eyes. Pure geometry, unit-tested.
 */

import {
  center,
  contains,
  distanceTo,
  inflate,
  intersection,
  overlaps,
  type Point,
  type Rect,
} from "./geometry";

export interface LensTarget {
  ref: string;
  name: string;
  rect: Rect;
}

export interface LensItem {
  ref: string;
  name: string;
  /** Where it is drawn in the lens (viewport coordinates). */
  rect: Rect;
  /** Where a look counts: at least `minHit` across where there is room, never overlapping another. */
  hit: Rect;
}

export interface Lens {
  /** The part of the page that is magnified (viewport coordinates). */
  source: Rect;
  /** Where the lens is drawn. */
  box: Rect;
  zoom: number;
  items: LensItem[];
}

export interface LensOptions {
  /** How far off the eyes may be (px): targets this close to the point are candidates. */
  errorRadius: number;
  /** A target at least this big on its shortest side is easy to choose directly. */
  comfortable: number;
  /** Smallest hit area in the lens (px). */
  minHit: number;
  minZoom: number;
  maxZoom: number;
  /** Space kept around the lens inside the viewport. */
  margin: number;
}

export const DEFAULT_LENS: LensOptions = {
  errorRadius: 60,
  comfortable: 72,
  minHit: 64,
  minZoom: 2,
  maxZoom: 4,
  margin: 24,
};

export type ZoomDecision = { kind: "direct"; target: LensTarget } | { kind: "lens"; lens: Lens };

const minSide = (r: Rect) => Math.min(r.width, r.height);

/** Big targets with nothing else close by: in "Zoom to choose" these can be chosen directly. */
export function directTargets(targets: readonly LensTarget[], opts: Partial<LensOptions> = {}): LensTarget[] {
  const o = { ...DEFAULT_LENS, ...opts };
  return targets.filter(
    (t) =>
      minSide(t.rect) >= o.comfortable &&
      !targets.some(
        (u) => u !== t && overlaps(inflate(t.rect, o.errorRadius / 2), u.rect) && !nested(u.rect, t.rect),
      ),
  );
}

function nested(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** What a look at `p` means: a big, clear target directly, or a lens on that part of the page. */
export function decideAt(
  p: Point,
  targets: readonly LensTarget[],
  viewport: { width: number; height: number },
  opts: Partial<LensOptions> = {},
): ZoomDecision {
  const o = { ...DEFAULT_LENS, ...opts };
  const near = targets.filter((t) => distanceTo(p, t.rect) <= o.errorRadius);
  const inside = near.find((t) => contains(t.rect, p) && minSide(t.rect) >= o.comfortable);
  if (inside) {
    const others = near.filter((t) => t !== inside && !nested(t.rect, inside.rect));
    if (others.every((t) => distanceTo(p, t.rect) > o.errorRadius / 2))
      return { kind: "direct", target: inside };
  }
  return { kind: "lens", lens: lensAt(p, targets, viewport, opts) };
}

/** The lens for a look at `p`: how much to magnify, which part, where it is drawn, and its targets. */
export function lensAt(
  p: Point,
  targets: readonly LensTarget[],
  viewport: { width: number; height: number },
  opts: Partial<LensOptions> = {},
): Lens {
  const o = { ...DEFAULT_LENS, ...opts };
  const boxW = Math.max(200, Math.min(viewport.width - 2 * o.margin, 1000));
  const boxH = Math.max(160, Math.min(viewport.height - 2 * o.margin, 640));
  const box: Rect = {
    x: Math.round((viewport.width - boxW) / 2),
    y: Math.round((viewport.height - boxH) / 2),
    width: boxW,
    height: boxH,
  };
  const near = targets.filter((t) => distanceTo(p, t.rect) <= o.errorRadius * 2);
  const smallest = near.length ? Math.max(4, Math.min(...near.map((t) => minSide(t.rect)))) : 24;
  const zoom = Math.max(o.minZoom, Math.min(o.maxZoom, Math.round(((o.minHit * 1.1) / smallest) * 2) / 2));
  const sw = Math.min(viewport.width, boxW / zoom);
  const sh = Math.min(viewport.height, boxH / zoom);
  // Centred on the things near the look (when they fit), not on empty page around them.
  let focus = p;
  if (near.length) {
    const x0 = Math.min(...near.map((t) => t.rect.x));
    const y0 = Math.min(...near.map((t) => t.rect.y));
    const x1 = Math.max(...near.map((t) => t.rect.x + t.rect.width));
    const y1 = Math.max(...near.map((t) => t.rect.y + t.rect.height));
    focus = {
      x: x1 - x0 <= sw ? (x0 + x1) / 2 : p.x,
      y: y1 - y0 <= sh ? (y0 + y1) / 2 : p.y,
    };
  }
  const source: Rect = {
    x: Math.max(0, Math.min(viewport.width - sw, focus.x - sw / 2)),
    y: Math.max(0, Math.min(viewport.height - sh, focus.y - sh / 2)),
    width: sw,
    height: sh,
  };
  const mapped: LensItem[] = [];
  for (const t of targets) {
    const visible = intersection(t.rect, source);
    // Mostly in view (at least 80% each way), so the lens never offers a sliver of something.
    if (!visible || visible.width < t.rect.width * 0.8 || visible.height < t.rect.height * 0.8) continue;
    const rect: Rect = {
      x: box.x + (visible.x - source.x) * zoom,
      y: box.y + (visible.y - source.y) * zoom,
      width: visible.width * zoom,
      height: visible.height * zoom,
    };
    mapped.push({ ref: t.ref, name: t.name, rect, hit: rect });
  }
  return { source, box, zoom, items: spreadHits(mapped, box, o.minHit) };
}

/**
 * Grows each item's hit area towards `minHit` across, but only into free space: hit areas never overlap, and never
 * leave the lens. Items that already overlap keep their own (smaller of the two) shapes.
 */
export function spreadHits(items: readonly LensItem[], box: Rect, minHit: number): LensItem[] {
  const out = items.map((i) => ({ ...i, hit: { ...i.rect } }));
  for (let pass = 0; pass < 2; pass++) {
    for (const it of out) {
      const want = Math.max(0, (minHit - Math.min(it.rect.width, it.rect.height)) / 2);
      for (let grow = want; grow >= 1; grow = Math.floor(grow / 2)) {
        const bigger = inflate(it.rect, grow);
        const inBox = intersection(bigger, box);
        if (!inBox) break;
        if (out.some((o) => o !== it && overlaps(o.hit, inBox))) continue;
        it.hit = inBox;
        break;
      }
    }
  }
  return out;
}

/** The grid of places to look at in "Zoom to choose" (one look on a cell opens the lens there). */
export function zoomCells(viewport: { width: number; height: number }, size = 150): Rect[] {
  const cols = Math.max(1, Math.round(viewport.width / size));
  const rows = Math.max(1, Math.round(viewport.height / size));
  const w = viewport.width / cols;
  const h = viewport.height / rows;
  const cells: Rect[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      // Whole pixels, so neighbouring cells meet exactly.
      const x = Math.round(c * w);
      const y = Math.round(r * h);
      cells.push({ x, y, width: Math.round((c + 1) * w) - x, height: Math.round((r + 1) * h) - y });
    }
  return cells;
}

export { center };
