/**
 * The fallback gaze source: the mouse pointer, read in the main process. Used when the gaze engine (os/gaze) is
 * not installed or the person or a helper chooses mouse input. Emits GazeEvents exactly like the engine.
 */

import type { GazeEvent } from "@agency/contracts";

export interface Point {
  x: number;
  y: number;
}

export class MouseGaze {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: Point | null = null;
  private lastEmit = 0;
  private readonly start = performance.now();

  constructor(
    private readonly read: () => Point,
    private readonly emit: (event: GazeEvent) => void,
    private readonly hz = 60,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  begin(): void {
    if (this.timer) return;
    this.emit({ type: "tracking", t: this.now(), state: "ok" });
    this.timer = setInterval(() => this.tick(), Math.round(1000 / this.hz));
  }

  end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return performance.now() - this.start;
  }

  /** Exposed for tests. */
  tick(): void {
    const p = this.read();
    const t = this.now();
    const moved = this.last ? Math.hypot(p.x - this.last.x, p.y - this.last.y) : Infinity;
    // Still pointer: keep sending at 10 Hz so dwell can progress; moving pointer: every tick.
    if (moved === 0 && t - this.lastEmit < 100) return;
    this.last = p;
    this.lastEmit = t;
    this.emit({
      type: "sample",
      sample: { t, x: p.x, y: p.y, confidence: 1, fixation: moved < 3, source: "mouse" },
    });
  }
}
