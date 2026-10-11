/** The squint-to-scroll gesture (SquintScroll.tsx), kept free of the DOM so it can be tested. */

/** Squint score that starts scrolling, and the lower one that ends it (hysteresis). */
export const SQUINT_ON = 0.45;
export const SQUINT_OFF = 0.3;
/** The squint must last this long to count (a squint is held; a blink flickers). */
const HOLD_MS = 250;
/** Pointer movement (px) ignored around the start, so a steady head doesn't drift. */
const DEAD_PX = 24;
/** Scroll speed per px of head movement beyond the dead zone (px per second). */
const SPEED = 6;
const MAX_SPEED = 2400;

/** The squint gesture's state machine: on after a held squint, off when the eyes open. Pure, for tests. */
export class SquintGesture {
  private since: number | null = null;
  active = false;
  anchorY = 0;

  update(t: number, squint: number | null | undefined, y: number | null): "start" | "stop" | null {
    const s = squint ?? 0;
    if (!this.active) {
      if (s >= SQUINT_ON && y !== null) {
        this.since ??= t;
        if (t - this.since >= HOLD_MS) {
          this.active = true;
          this.anchorY = y;
          return "start";
        }
      } else this.since = null;
      return null;
    }
    if (s < SQUINT_OFF || y === null) {
      this.active = false;
      this.since = null;
      return "stop";
    }
    return null;
  }

  /** Scroll speed (px/s, positive = down) for the pointer's height now. */
  speed(y: number): number {
    const d = y - this.anchorY;
    if (Math.abs(d) <= DEAD_PX) return 0;
    const v = (Math.abs(d) - DEAD_PX) * SPEED * Math.sign(d);
    return Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
  }
}
