/**
 * Precision helpers for small or crowded targets. The engine decides; the overlay (Instance 3)
 * draws. Everything is in global screen points.
 *
 * - "direct": one target is clearly meant (or none is near): normal dwell.
 * - "picker": a few targets sit inside the gaze's error circle. Offer them as big labelled
 *   buttons (at least 96 pt, 24 pt apart) plus "None of these", so a second, easy dwell picks
 *   the right one.
 * - "magnify": too many targets, or targets without usable names. Zoom the region two to four
 *   times for a second, more precise dwell; magnifiedToScreen maps that dwell back.
 *
 * The error circle comes from measured accuracy (validation and recent selections) plus live
 * noise, so the helpers appear exactly when the tracker can't tell targets apart.
 */

import type { ScreenRect, Target } from "./contracts";

export interface PrecisionOptions {
  /** Most buttons in a picker (the plan's limit is about 8 choices per screen). */
  maxPickerOptions: number;
  pickerButtonPt: number;
  pickerGapPt: number;
  /** Size the magnifier aims to make the smallest candidate (points). */
  magnifiedTargetPt: number;
  minZoom: number;
  maxZoom: number;
}

export const DEFAULT_PRECISION: PrecisionOptions = {
  maxPickerOptions: 6,
  pickerButtonPt: 120,
  pickerGapPt: 24,
  magnifiedTargetPt: 120,
  minZoom: 2,
  maxZoom: 4,
};

export interface PickerButton {
  /** null for "None of these". */
  targetId: string | null;
  label: string;
  rect: ScreenRect;
}

export type PrecisionDecision =
  | { kind: "direct"; targetId: string | null }
  | { kind: "picker"; candidates: string[]; buttons: PickerButton[]; errorRadiusPt: number }
  | {
      kind: "magnify";
      candidates: string[];
      region: ScreenRect;
      zoom: number;
      lens: ScreenRect;
      errorRadiusPt: number;
    };

export function distanceToRect(x: number, y: number, r: ScreenRect): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

const contains = (r: ScreenRect, x: number, y: number) =>
  x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

/** Display that contains the point (or the nearest one). */
export function displayFor(displays: readonly ScreenRect[], x: number, y: number): ScreenRect {
  let best = displays[0]!;
  let bestD = Infinity;
  for (const d of displays) {
    const dist = distanceToRect(x, y, d);
    if (dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}

function clampRect(r: ScreenRect, bounds: ScreenRect): ScreenRect {
  const width = Math.min(r.width, bounds.width);
  const height = Math.min(r.height, bounds.height);
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, r.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, r.y)),
    width,
    height,
  };
}

const usableLabel = (t: Target) => t.label.trim().length > 0 && t.label.trim().length <= 60;

/** Labels a person can tell apart: duplicates get where they are ("Save, on the left"). */
export function pickerLabels(targets: readonly Target[]): string[] {
  const counts = new Map<string, number>();
  for (const t of targets) counts.set(t.label.trim(), (counts.get(t.label.trim()) ?? 0) + 1);
  const cx = targets.reduce((s, t) => s + t.rect.x + t.rect.width / 2, 0) / Math.max(targets.length, 1);
  const cy = targets.reduce((s, t) => s + t.rect.y + t.rect.height / 2, 0) / Math.max(targets.length, 1);
  return targets.map((t) => {
    const label = t.label.trim();
    if ((counts.get(label) ?? 0) < 2) return label;
    const dx = t.rect.x + t.rect.width / 2 - cx;
    const dy = t.rect.y + t.rect.height / 2 - cy;
    const where =
      Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "on the left" : "on the right") : dy < 0 ? "above" : "below";
    return `${label}, ${where}`;
  });
}

/** Lay out picker buttons in a grid centred near the gaze, inside the display. */
export function layoutPicker(
  centre: { x: number; y: number },
  labels: readonly { targetId: string | null; label: string }[],
  display: ScreenRect,
  o: PrecisionOptions = DEFAULT_PRECISION,
): PickerButton[] {
  const n = labels.length;
  const cols = n <= 3 ? n : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const w = Math.max(o.pickerButtonPt * 2, 240);
  const h = o.pickerButtonPt;
  const totalW = cols * w + (cols - 1) * o.pickerGapPt;
  const totalH = rows * h + (rows - 1) * o.pickerGapPt;
  const box = clampRect(
    { x: centre.x - totalW / 2, y: centre.y - totalH / 2, width: totalW, height: totalH },
    display,
  );
  return labels.map((l, i) => ({
    ...l,
    rect: {
      x: box.x + (i % cols) * (w + o.pickerGapPt),
      y: box.y + Math.floor(i / cols) * (h + o.pickerGapPt),
      width: w,
      height: h,
    },
  }));
}

export function decidePrecision(
  gaze: { x: number; y: number },
  errorRadiusPt: number,
  targets: readonly Target[],
  displays: readonly ScreenRect[],
  o: PrecisionOptions = DEFAULT_PRECISION,
): PrecisionDecision {
  const r = Math.max(errorRadiusPt, 8);
  const near = targets
    .map((t) => ({ t, d: distanceToRect(gaze.x, gaze.y, t.rect) }))
    .filter((c) => c.d <= r)
    .sort((a, b) => a.d - b.d || a.t.rect.width * a.t.rect.height - b.t.rect.width * b.t.rect.height);
  if (near.length === 0) return { kind: "direct", targetId: null };
  if (near.length === 1) return { kind: "direct", targetId: near[0]!.t.id };
  const first = near[0]!.t;
  // A big target under the gaze, with the error circle inside it, is not ambiguous.
  if (
    contains(first.rect, gaze.x, gaze.y) &&
    gaze.x - r >= first.rect.x &&
    gaze.x + r <= first.rect.x + first.rect.width &&
    gaze.y - r >= first.rect.y &&
    gaze.y + r <= first.rect.y + first.rect.height
  ) {
    return { kind: "direct", targetId: first.id };
  }
  const candidates = near.map((c) => c.t);
  const display = displayFor(displays, gaze.x, gaze.y);
  if (candidates.length <= o.maxPickerOptions && candidates.every(usableLabel)) {
    const labels = pickerLabels(candidates);
    const buttons = layoutPicker(
      gaze,
      [
        ...candidates.map((t, i) => ({ targetId: t.id, label: labels[i]! })),
        { targetId: null, label: "None of these" },
      ],
      display,
      o,
    );
    return { kind: "picker", candidates: candidates.map((t) => t.id), buttons, errorRadiusPt: r };
  }
  const smallest = Math.min(...candidates.map((t) => Math.min(t.rect.width, t.rect.height)));
  const zoom = Math.max(o.minZoom, Math.min(o.maxZoom, o.magnifiedTargetPt / Math.max(smallest, 1)));
  const side = Math.max(2.4 * r, 160);
  const region = clampRect(
    { x: gaze.x - side / 2, y: gaze.y - side / 2, width: side, height: side },
    display,
  );
  const lensSide = Math.min(side * zoom, display.width, display.height);
  const effectiveZoom = lensSide / side;
  const lens = clampRect(
    {
      x: region.x + region.width / 2 - lensSide / 2,
      y: region.y + region.height / 2 - lensSide / 2,
      width: lensSide,
      height: lensSide,
    },
    display,
  );
  return {
    kind: "magnify",
    candidates: candidates.map((t) => t.id),
    region,
    zoom: effectiveZoom,
    lens,
    errorRadiusPt: r,
  };
}

/** A point on the magnified lens back to the real screen point it shows. */
export function magnifiedToScreen(
  m: { region: ScreenRect; lens: ScreenRect },
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: m.region.x + ((x - m.lens.x) / m.lens.width) * m.region.width,
    y: m.region.y + ((y - m.lens.y) / m.lens.height) * m.region.height,
  };
}

/** A real screen point to where it appears on the lens (to draw magnified targets). */
export function screenToMagnified(
  m: { region: ScreenRect; lens: ScreenRect },
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: m.lens.x + ((x - m.region.x) / m.region.width) * m.lens.width,
    y: m.lens.y + ((y - m.region.y) / m.region.height) * m.lens.height,
  };
}

/** Magnified copies of the candidate targets' rectangles, for hit-testing the second dwell. */
export function magnifiedTargets(
  m: { region: ScreenRect; lens: ScreenRect },
  targets: readonly Target[],
): Target[] {
  return targets.map((t) => {
    const a = screenToMagnified(m, t.rect.x, t.rect.y);
    const b = screenToMagnified(m, t.rect.x + t.rect.width, t.rect.y + t.rect.height);
    return { ...t, rect: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y } };
  });
}
