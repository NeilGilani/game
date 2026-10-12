/**
 * Guards on what the eyes can choose, kept free of the DOM so they can be tested (InputLayer.tsx does the
 * hit-testing with document.elementFromPoint):
 * - Only what can be seen can be chosen: a control covered by something else (the eye keyboard, a sheet) is
 *   not a target, and where the pointer is over something covering part of a control, that control is not chosen.
 * - A control that just appeared, moved or changed size has to hold still for a moment before its dwell fills,
 *   so new choices arriving under a resting gaze (AI suggestions, a list that shifts) are not chosen by accident.
 */
import type { Rect } from "../../../os/gaze/src/input/targets";

type Point = { x: number; y: number };

/** Where to hit-test a control: its centre, then a point inside each corner, kept within the viewport. */
export function probePoints(r: Rect, width: number, height: number): Point[] {
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  const at = (fx: number, fy: number) => ({ x: clampX(r.left + w * fx), y: clampY(r.top + h * fy) });
  return [at(0.5, 0.5), at(0.2, 0.2), at(0.8, 0.2), at(0.2, 0.8), at(0.8, 0.8)];
}

export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** How long a new or moved control must hold still before its dwell can fill (ms). */
export const SETTLE_MS = 500;
/** Movement or change of size (px) that counts as moved. */
export const MOVED_PX = 8;

/** Without a look at the screen for this long (no camera frames), nothing is known about what just changed (ms). */
export const UNSEEN_MS = 1000;

/**
 * Remembers where each control was and since when it has held still. It only knows what it was shown: after a
 * gap with no frames (the first frames of all, the camera resuming) the controls on screen count as settled,
 * since nothing was seen to change. Screen changes have their own pause (InputLayer's navigation hold).
 */
export class SettleGuard {
  private seen = new Map<string, { rect: Rect; since: number }>();
  private lastAt: number | null = null;

  constructor(
    private settleMs = SETTLE_MS,
    private movedPx = MOVED_PX,
  ) {}

  /** Record this moment's controls; returns the ids that are still settling. */
  update(now: number, targets: readonly { id: string; rect: Rect }[]): Set<string> {
    const unseen = this.lastAt === null || now - this.lastAt > UNSEEN_MS;
    this.lastAt = now;
    // Each control is compared with where it was when it last came to rest, so a slow drift adds up too.
    const next = new Map<string, { rect: Rect; since: number }>();
    const settling = new Set<string>();
    for (const t of targets) {
      if (unseen) {
        next.set(t.id, { rect: t.rect, since: -Infinity });
        continue;
      }
      const rest = this.seen.get(t.id);
      const moved =
        !rest ||
        Math.abs(rest.rect.left - t.rect.left) > this.movedPx ||
        Math.abs(rest.rect.top - t.rect.top) > this.movedPx ||
        Math.abs(rest.rect.right - t.rect.right) > this.movedPx ||
        Math.abs(rest.rect.bottom - t.rect.bottom) > this.movedPx;
      const entry = !moved && rest ? rest : { rect: t.rect, since: now };
      next.set(t.id, entry);
      if (now - entry.since < this.settleMs) settling.add(t.id);
    }
    this.seen = next;
    return settling;
  }
}
