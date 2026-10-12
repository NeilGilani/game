/**
 * "Choose on page": a big numbered label next to everything that can be chosen, placed so labels never overlap and
 * each has room around it for the eyes. What doesn't fit goes to the next set ("More"). The same targets, grouped
 * and with repeated names merged, make the side list. Pure, so it is unit-tested.
 */

import { bottom, clampInto, inflate, overlaps, right, type Rect } from "./geometry";

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
  /** The label itself. */
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

export const DEFAULT_LABELS: LabelOptions = { height: 52, digitWidth: 17, padding: 22, gap: 12, max: 60 };

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

/**
 * Where a label may go for a target, best first. Small things (a link in a line of text) get it beside them, below
 * or above, so the label never hides the words it stands for; big things (a card, a large button) get it on their
 * top-left corner, inside.
 */
function candidates(t: Rect, w: number, h: number): Rect[] {
  const cy = t.y + t.height / 2 - h / 2;
  const out: Rect[] = [];
  const at = (x: number, y: number) => out.push({ x, y, width: w, height: h });
  const big = t.width >= w * 2 && t.height >= h * 1.5;
  if (big) at(t.x + 4, t.y + 4);
  at(t.x - w - 6, cy);
  at(t.x, bottom(t) + 4);
  at(t.x, t.y - h - 4);
  at(right(t) + 6, cy);
  // Along the element's bottom and top edges, for wide ones (a row of links).
  for (const dx of [w + 8, -(w + 8), 2 * (w + 8)]) {
    at(t.x + dx, bottom(t) + 4);
    at(t.x + dx, t.y - h - 4);
  }
  if (!big) at(t.x + t.width / 2 - w / 2, t.y + t.height / 2 - h / 2);
  // A small spiral around the element, last.
  for (const r of [h, 2 * h, 3 * h])
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const)
      at(t.x + dx * r, cy + dy * r);
  return out;
}

/** One set of labels from `targets` (in reading order), numbered from `firstCode`. The rest are left over. */
export function layoutLabels(
  targets: readonly LabelTarget[],
  viewport: { width: number; height: number },
  firstCode = 1,
  opts: Partial<LabelOptions> = {},
): { placed: PlacedLabel[]; rest: LabelTarget[] } {
  const o = { ...DEFAULT_LABELS, ...opts };
  const box: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const placed: PlacedLabel[] = [];
  const rest: LabelTarget[] = [];
  const ordered = readingOrder(targets);
  for (const t of ordered) {
    if (placed.length >= o.max) {
      rest.push(t);
      continue;
    }
    const code = String(firstCode + placed.length);
    const { width, height } = chipSize(code, o);
    let best: { chip: Rect; score: number } | null = null;
    const list = candidates(t.rect, width, height);
    for (let i = 0; i < list.length; i++) {
      const c = list[i]!;
      const r = clampInto(c, box);
      // A label too far from its element (clamped across the page) would point at the wrong thing.
      if (Math.abs(r.x - c.x) > width || Math.abs(r.y - c.y) > height) continue;
      if (placed.some((p) => overlaps(p.chip, r, o.gap))) continue;
      // Prefer not to hide other things that can be chosen, or the words of this one.
      const hides = ordered.filter((u) => u !== t && overlaps(u.rect, r)).length;
      const ownText = t.rect.width < width * 2 || t.rect.height < height * 1.5 ? overlaps(t.rect, r) : false;
      const score = i + hides * 100 + (ownText ? 40 : 0);
      if (!best || score < best.score) best = { chip: r, score };
      if (score === i) break;
    }
    if (!best) {
      rest.push(t);
      continue;
    }
    placed.push({
      ref: t.ref,
      code,
      chip: best.chip,
      hit: inflate(best.chip, Math.floor(o.gap / 2)),
      target: t.rect,
    });
  }
  return { placed, rest };
}

/** All targets as sets of labels: the first set, then "More" for the next, and so on (at most `maxSets`). */
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
    const { placed, rest } = layoutLabels(left, viewport, next, opts);
    if (!placed.length) break;
    sets.push(placed);
    next += placed.length;
    left = rest;
  }
  return sets;
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
