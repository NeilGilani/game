/**
 * Frame-rate governor: full rate while the person is using eye control, lower when idle, to save
 * battery and heat. Never below `floorFps` while the camera is on, because Lifeline's help
 * signal (three long blinks) must keep working at all times, including while eye control is
 * paused and while nobody is in view (they may come back into view to signal).
 */

export interface FrameRateOptions {
  activeFps: number;
  /** Eye control paused, or the person is resting (eyes closed a while). */
  restingFps: number;
  /** Nobody in view for idleAfterMs. */
  idleFps: number;
  /** Absolute minimum: the help pattern needs closures of 0.6 s resolved to about 0.1 s. */
  floorFps: number;
  idleAfterMs: number;
}

export const DEFAULT_FRAME_RATE: FrameRateOptions = {
  activeFps: 30,
  restingFps: 15,
  idleFps: 10,
  floorFps: 10,
  idleAfterMs: 5000,
};

export class FrameRateGovernor {
  private o: FrameRateOptions;
  private lastFaceAt = -Infinity;
  private paused = false;
  private cap: number | null = null;
  private lastSeenAt = -Infinity;
  private lastFrameAt = -Infinity;

  constructor(options: Partial<FrameRateOptions> = {}) {
    this.o = { ...DEFAULT_FRAME_RATE, ...options };
    this.o.idleFps = Math.max(this.o.idleFps, this.o.floorFps);
    this.o.restingFps = Math.max(this.o.restingFps, this.o.floorFps);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * An outside limit (the desktop slows this engine while its own window tracks the eyes), or null for none. It can
   * only lower the rate, and never below `floorFps`: Lifeline's help signal keeps working whatever is asked.
   */
  setCap(fps: number | null): void {
    this.cap = fps === null || !Number.isFinite(fps) ? null : Math.max(this.o.floorFps, fps);
  }

  /** Record what the last processed frame saw. */
  observe(t: number, face: boolean): void {
    this.lastSeenAt = t;
    if (face) this.lastFaceAt = t;
  }

  /** The target at the last observed frame (on the frames' own clock). */
  currentFps(): number {
    return this.targetFps(Number.isFinite(this.lastSeenAt) ? this.lastSeenAt : this.lastFaceAt);
  }

  targetFps(t: number): number {
    const base =
      t - this.lastFaceAt > this.o.idleAfterMs
        ? this.o.idleFps
        : this.paused
          ? this.o.restingFps
          : this.o.activeFps;
    return this.cap === null ? base : Math.min(base, this.cap);
  }

  /** True if a frame arriving at t should be processed (the camera may deliver faster). */
  shouldProcess(t: number): boolean {
    const interval = 1000 / this.targetFps(t);
    // Small tolerance so a 30 fps camera isn't decimated to 15 by timing jitter.
    if (t - this.lastFrameAt >= interval * 0.8) {
      this.lastFrameAt = t;
      return true;
    }
    return false;
  }
}
