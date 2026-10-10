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
  private lastFrameAt = -Infinity;

  constructor(options: Partial<FrameRateOptions> = {}) {
    this.o = { ...DEFAULT_FRAME_RATE, ...options };
    this.o.idleFps = Math.max(this.o.idleFps, this.o.floorFps);
    this.o.restingFps = Math.max(this.o.restingFps, this.o.floorFps);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Record what the last processed frame saw. */
  observe(t: number, face: boolean): void {
    if (face) this.lastFaceAt = t;
  }

  targetFps(t: number): number {
    if (t - this.lastFaceAt > this.o.idleAfterMs) return this.o.idleFps;
    if (this.paused) return this.o.restingFps;
    return this.o.activeFps;
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
