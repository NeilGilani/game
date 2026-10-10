/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012): smooths jitter when the signal is
 * still and follows quickly when it moves. Used for the on-screen gaze/head pointer.
 */

class LowPass {
  private value: number | null = null;

  filter(x: number, alpha: number): number {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value;
    return this.value;
  }

  last(): number | null {
    return this.value;
  }

  reset(): void {
    this.value = null;
  }
}

export interface OneEuroOptions {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastTime: number | null = null;

  constructor(private options: OneEuroOptions = { minCutoff: 1.0, beta: 0.01, dCutoff: 1.0 }) {}

  setOptions(options: Partial<OneEuroOptions>): void {
    this.options = { ...this.options, ...options };
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, timeMs: number): number {
    const prevTime = this.lastTime;
    this.lastTime = timeMs;
    const prev = this.x.last();
    if (prevTime === null || prev === null || timeMs <= prevTime) {
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    const dt = (timeMs - prevTime) / 1000;
    const derivative = (value - prev) / dt;
    const edx = this.dx.filter(derivative, OneEuroFilter.alpha(this.options.dCutoff, dt));
    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(edx);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}

export class PointFilter {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  constructor(options?: OneEuroOptions) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
  }

  setOptions(options: Partial<OneEuroOptions>): void {
    this.fx.setOptions(options);
    this.fy.setOptions(options);
  }

  filter(x: number, y: number, timeMs: number): { x: number; y: number } {
    return { x: this.fx.filter(x, timeMs), y: this.fy.filter(y, timeMs) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
