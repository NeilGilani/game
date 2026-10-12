/** How the scroll zones glide (pure, unit-tested). */

/** Speed in px/s after `heldMs` of looking: 240 at first, up to 1400 after three seconds. */
export function glideSpeed(heldMs: number): number {
  const t = Math.max(0, Math.min(1, heldMs / 3000));
  return Math.round(240 + (1400 - 240) * t * t);
}

/** Before gliding starts, the eyes must rest on the zone this long (a glance across it does nothing). */
export const GLIDE_DELAY_MS = 450;
