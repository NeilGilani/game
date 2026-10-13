/**
 * "Choose on page": a big numbered label touching each thing that can be chosen, with the thing outlined in the
 * label's colour, so it is clear which number belongs to what. Labels never overlap and each has room around it for
 * the eyes. When a page is too crowded for that, it is first split into a few big lettered areas: choosing one zooms
 * in on it, and its things get their numbers there. The same targets, grouped and with repeated names merged, make the
 * side list. Pure, so it is unit-tested.
 */

import { bottom, center, clampInto, contains, inflate, overlaps, right, type Rect } from "./geometry";

export interface LabelTarget {
  ref: string;
  name: string;
  kind: "link" | "button" | "field" | "choice" | "list" | "other";
  rect: Rect;
  secure?: boolean;
}

export interface PlacedLabel {
  ref: string;
  /** What the label says: 1, 2, 3... */
  code: string;
  /** The label itself, touching its target. */
  chip: Rect;
  /** Where a look counts for it: the label with a margin, never touching another label's. */
  hit: Rect;
  /** The element it points to. */
  target: Rect;
}

export interface LabelOptions {
  /** Label height (px). */
  height: number;
  /** Width of one digit (px), plus padding. */
  digitWidth: number;
  padding: number;
  /** Space between labels (px). Half of it on each side is the label's hit margin. */
  gap: number;
  /** Most labels in one set. */
  max: number;
}

export const DEFAULT_LABELS: LabelOptions = { height: 52, digitWidth: 17, padding: 14, gap: 12, max: 60 };

/** How far a label overlaps its target's edge, so the two read as one. */
const JOIN = 3;
/** Steps when sliding a label along its target's edge to make room. */
const SLIDE = 6;
/** How far a label may move in from the page's edge. */
const NUDGE = 10;
/** A label may cover this much of its own thing's ends. */
const EDGE = NUDGE + JOIN;
/** The cost of a label covering another thing that can be chosen. */
const HIDES = 400;

/** Reading order: top to bottom in rows (things within half a line of each other share a row), then left to right. */
export function readingOrder<T extends { rect: Rect }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const row = Math.min(a.rect.height, b.rect.height, 24) / 2;
    if (Math.abs(a.rect.y - b.rect.y) > row) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });
}

function chipSize(code: string, o: LabelOptions): { width: number; height: number } {
  return { width: Math.max(o.height + 8, o.padding * 2 + code.length * o.digitWidth), height: o.height };
}

/** Positions from `from` within [lo, hi], nearest to `from` first, in SLIDE steps. */
function slide(from: number, lo: number, hi: number): number[] {
  const out = [from];
  for (let d = SLIDE; from - d >= lo || from + d <= hi; d += SLIDE) {
    if (from + d <= hi) out.push(from + d);
    if (from - d >= lo) out.push(from - d);
  }
  return out;
}

/** Big enough to carry its label inside, on its corner. */
const roomy = (t: Rect, w: number, h: number) => t.width >= w * 1.6 && t.height >= h + 8;

/**
 * Where a label may go for a target, best first, always touching it. Big things (a card, a large button) get it
 * inside their top-left corner. Small things (a link in a line of text) get it on their left edge, then on top, then
 * below, then on the right, so it doesn't hide the words it stands for; to make room it slides along that edge,
 * never away from it. Last, over the thing itself.
 */
export function candidates(t: Rect, w: number, h: number): Rect[] {
  const out: Rect[] = [];
  const at = (x: number, y: number) => out.push({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  const big = roomy(t, w, h);
  if (big) {
    at(t.x + 4, t.y + 4);
    at(right(t) - w - 4, t.y + 4);
  }
  // Along each edge the label may slide while it still overlaps that edge by a good part.
  const keepY = Math.min(16, t.height / 2);
  const keepX = Math.min(20, t.width / 2);
  const cy = t.y + t.height / 2 - h / 2;
  for (const y of slide(cy, t.y - h + keepY, bottom(t) - keepY)) at(t.x - w + JOIN, y);
  for (const x of slide(t.x, t.x - w + keepX, right(t) - keepX)) at(x, t.y - h + JOIN);
  for (const x of slide(t.x, t.x - w + keepX, right(t) - keepX)) at(x, bottom(t) - JOIN);
  for (const y of slide(cy, t.y - h + keepY, bottom(t) - keepY)) at(right(t) - JOIN, y);
  if (!big) at(t.x + t.width / 2 - w / 2, cy);
  return out;
}

const inside = (r: Rect, box: Rect) =>
  r.x >= box.x && r.y >= box.y && right(r) <= right(box) && bottom(r) <= bottom(box);

/** One set of labels from `targets`, numbered from `firstCode` in reading order. The rest are left over. */
export function layoutLabels(
  targets: readonly LabelTarget[],
  viewport: { width: number; height: number },
  firstCode = 1,
  opts: Partial<LabelOptions> = {},
  /** Off: a label may cover another thing when there is no other way (so every thing gets a number in the end). */
  strict = true,
): { placed: PlacedLabel[]; rest: LabelTarget[] } {
  const o = { ...DEFAULT_LABELS, ...opts };
  const box: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const spots: { t: LabelTarget; chip: Rect }[] = [];
  const rest: LabelTarget[] = [];
  const ordered = readingOrder(targets);
  // Sized for the longest number this set could reach, so every label in it is the same size.
  const size = chipSize(String(firstCode + Math.min(o.max, ordered.length) - 1), o);
  for (const t of ordered) {
    if (spots.length >= o.max) {
      rest.push(t);
      continue;
    }
    let best: { chip: Rect; score: number } | null = null;
    const list = candidates(t.rect, size.width, size.height);
    for (let i = 0; i < list.length; i++) {
      // A label just past the page's edge moves in a little (it then covers a sliver of its own thing).
      const r = clampInto(list[i]!, box);
      if (Math.abs(r.x - list[i]!.x) > NUDGE || Math.abs(r.y - list[i]!.y) > NUDGE || !inside(r, box))
        continue;
      if (spots.some((p) => overlaps(p.chip, r, o.gap))) continue;
      // Prefer not to hide other things that can be chosen, or the words of this one. Positions further along the
      // list have slid further from the natural spot.
      const hides = ordered.filter((u) => u !== t && overlaps(u.rect, r)).length;
      const words = { ...t.rect, x: t.rect.x + EDGE, width: t.rect.width - 2 * EDGE };
      const ownText = !roomy(t.rect, size.width, size.height) && overlaps(inflate(words, -JOIN - 1), r);
      const score = i + hides * HIDES + (ownText ? 200 : 0);
      if (!best || score < best.score) best = { chip: r, score };
      if (score === i) break;
    }
    // A label that would hide another thing waits for the next set, where there is more room.
    if (!best || (strict && best.score >= HIDES)) {
      rest.push(t);
      continue;
    }
    spots.push({ t, chip: best.chip });
  }
  const placed = spots.map(({ t, chip }, i) => ({
    ref: t.ref,
    code: String(firstCode + i),
    chip,
    hit: inflate(chip, Math.floor(o.gap / 2)),
    target: t.rect,
  }));
  return { placed, rest };
}

/** All targets as sets of labels: the first set, then "More numbers" for the next, and so on (at most `maxSets`). */
export function labelSets(
  targets: readonly LabelTarget[],
  viewport: { width: number; height: number },
  opts: Partial<LabelOptions> = {},
  maxSets = 8,
): PlacedLabel[][] {
  const sets: PlacedLabel[][] = [];
  let left = [...targets];
  let next = 1;
  while (left.length && sets.length < maxSets) {
    let { placed, rest } = layoutLabels(left, viewport, next, opts);
    if (!placed.length) ({ placed, rest } = layoutLabels(left, viewport, next, opts, false));
    if (!placed.length) break;
    sets.push(placed);
    next += placed.length;
    left = rest;
  }
  return sets;
}

// ---- Crowded pages: areas first, then zoom in -----------------------------------------------------------------

export interface Area {
  /** A, B, C... */
  code: string;
  /** Its part of the screen (areas don't overlap): where a look chooses it. */
  hit: Rect;
  /** What zooming in shows: the box around its things, with a margin. */
  focus: Rect;
  refs: string[];
}

/** When the numbers need more than one set for at least this many things: areas first. */
export const AREAS_FROM = 16;
/** The most a zoom magnifies. */
export const MAX_ZOOM = 4;

/**
 * Should this picture show lettered areas instead of numbers? When the numbers wouldn't fit in one set and there are
 * many things, yes: numbers scattered across a crowded page are hard to match to their links.
 */
export function needsAreas(sets: readonly PlacedLabel[][], count: number): boolean {
  return sets.length > 1 && count >= AREAS_FROM;
}

/** Grids to try, coarse to fine: the first that leaves few enough things in each area wins. */
const GRIDS: [number, number][] = [
  [3, 2],
  [4, 2],
  [4, 3],
  [5, 3],
];
/** Few enough things in one area that, zoomed in, they get their numbers in one go. */
const PER_AREA = 12;

function gridAreas(
  targets: readonly LabelTarget[],
  viewport: { width: number; height: number },
  cols: number,
  rows: number,
): Area[] {
  const cw = viewport.width / cols;
  const ch = viewport.height / rows;
  const out: Area[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const hit = {
        x: Math.round(c * cw),
        y: Math.round(r * ch),
        width: Math.round((c + 1) * cw) - Math.round(c * cw),
        height: Math.round((r + 1) * ch) - Math.round(r * ch),
      };
      const mine = targets.filter((t) => contains(hit, center(t.rect)));
      if (!mine.length) continue;
      const x = Math.min(...mine.map((t) => t.rect.x));
      const y = Math.min(...mine.map((t) => t.rect.y));
      const focus = inflate(
        {
          x,
          y,
          width: Math.max(...mine.map((t) => right(t.rect))) - x,
          height: Math.max(...mine.map((t) => bottom(t.rect))) - y,
        },
        24,
      );
      out.push({
        code: String.fromCharCode(65 + out.length),
        hit,
        focus,
        refs: readingOrder(mine).map((t) => t.ref),
      });
    }
  return out;
}

/**
 * The page split into a grid of big areas, keeping only areas with things in them. A thing belongs to the area its
 * centre is in. The grid is as coarse as it can be (at most 5 across and 3 down, so each area stays a big target)
 * while each area holds few enough things to number them all once zoomed in.
 */
export function areasOf(
  targets: readonly LabelTarget[],
  viewport: { width: number; height: number },
): Area[] {
  let areas: Area[] = [];
  for (const [cols, rows] of GRIDS) {
    areas = gridAreas(targets, viewport, cols, rows);
    if (Math.max(...areas.map((a) => a.refs.length)) <= PER_AREA) break;
  }
  return areas;
}

export interface Zoom {
  scale: number;
  /** Where the focus rect's top-left lands on screen. */
  dx: number;
  dy: number;
}

/** Zooming into `focus` so it fills the viewport, centred: at most MAX_ZOOM, and never smaller than the page. */
export function zoomInto(focus: Rect, viewport: { width: number; height: number }): Zoom {
  const scale = Math.max(1, Math.min(MAX_ZOOM, viewport.width / focus.width, viewport.height / focus.height));
  return {
    scale,
    dx: (viewport.width - focus.width * scale) / 2,
    dy: (viewport.height - focus.height * scale) / 2,
  };
}

/** A rect on the page, as it shows when zoomed into `focus`. */
export function zoomRect(r: Rect, focus: Rect, z: Zoom): Rect {
  return {
    x: (r.x - focus.x) * z.scale + z.dx,
    y: (r.y - focus.y) * z.scale + z.dy,
    width: r.width * z.scale,
    height: r.height * z.scale,
  };
}

export interface TargetGroup {
  id: "fields" | "buttons" | "links" | "choices" | "other";
  title: string;
  entries: { name: string; refs: string[] }[];
}

const GROUPS: { id: TargetGroup["id"]; title: string; kinds: LabelTarget["kind"][] }[] = [
  { id: "fields", title: "Boxes to type in", kinds: ["field", "list"] },
  { id: "buttons", title: "Buttons", kinds: ["button"] },
  { id: "links", title: "Links", kinds: ["link"] },
  { id: "choices", title: "Choices", kinds: ["choice"] },
  { id: "other", title: "Other", kinds: ["other"] },
];

function plainName(t: LabelTarget): string {
  const n = t.name.replace(/\s+/g, " ").trim();
  if (n) return n.length > 60 ? `${n.slice(0, 59)}…` : n;
  if (t.kind === "field") return t.secure ? "Password box" : "Text box";
  if (t.kind === "link") return "Link with no name";
  if (t.kind === "button") return "Button with no name";
  return "Unnamed";
}

/** The side list: grouped by kind, in reading order, with the same name merged into one entry. */
export function groupTargets(targets: readonly LabelTarget[]): TargetGroup[] {
  const ordered = readingOrder(targets);
  return GROUPS.map((g) => {
    const byName = new Map<string, { name: string; refs: string[] }>();
    for (const t of ordered) {
      if (!g.kinds.includes(t.kind)) continue;
      const name = plainName(t);
      const key = name.toLowerCase();
      const e = byName.get(key);
      if (e) e.refs.push(t.ref);
      else byName.set(key, { name, refs: [t.ref] });
    }
    return { id: g.id, title: g.title, entries: [...byName.values()] };
  }).filter((g) => g.entries.length > 0);
}
