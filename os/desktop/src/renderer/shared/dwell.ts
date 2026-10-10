/**
 * Minimal dwell selection for the built-in pages. The full engine (snapping, pickers, magnifier) belongs to
 * os/gaze and os/overlay; this one only has to be safe: no dwell below 0.5 confidence, nothing selects twice
 * without the gaze leaving first, and no time limit.
 */

import type { GazeSample, Target } from "@agency/contracts";

export interface DwellResult {
  current: Target | null;
  progress: number;
  selected: Target | null;
}

/** Gaze within this many points of a target's edge still counts as on it. */
const SNAP = 24;

export function hitTest(x: number, y: number, targets: Target[]): Target | null {
  let best: Target | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    const dx = Math.max(t.rect.x - x, 0, x - (t.rect.x + t.rect.width));
    const dy = Math.max(t.rect.y - y, 0, y - (t.rect.y + t.rect.height));
    const d = Math.hypot(dx, dy);
    // Protected targets win ties so Help and Stop are never shadowed.
    if (d <= SNAP && (d < bestDist || (d === bestDist && t.protected))) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

export class DwellTracker {
  private current: Target | null = null;
  private since = 0;
  private fired = false;

  constructor(private readonly opts: { dwellMs: number }) {}

  update(s: GazeSample, targets: Target[]): DwellResult {
    if (s.confidence < 0.5) {
      this.current = null;
      this.fired = false;
      return { current: null, progress: 0, selected: null };
    }
    const hit = hitTest(s.x, s.y, targets);
    if (!hit || hit.id !== this.current?.id) {
      this.current = hit;
      this.since = s.t;
      this.fired = false;
      return { current: hit, progress: 0, selected: null };
    }
    const needed = this.opts.dwellMs * (hit.dwellScale ?? 1);
    const progress = Math.min(1, (s.t - this.since) / needed);
    if (progress >= 1 && !this.fired) {
      this.fired = true;
      return { current: hit, progress: 1, selected: hit };
    }
    return { current: hit, progress: this.fired ? 1 : progress, selected: null };
  }
}
