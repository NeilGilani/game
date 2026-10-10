/**
 * Sequential scanning: highlight each choice in turn; a single switch press (a key, or a
 * deliberate long blink via the camera) selects the highlighted one.
 *
 * Scanning pauses after a few full passes without a press, so it doesn't cycle forever
 * while the person is resting; any press restarts it.
 */

export interface ScanConfig {
  intervalMs: number;
  /** Extra time on the first item after a restart or a selection. */
  firstItemExtraMs: number;
  /** Full passes without a press before scanning pauses. */
  maxPasses: number;
}

export const DEFAULT_SCAN: ScanConfig = { intervalMs: 1500, firstItemExtraMs: 700, maxPasses: 3 };

export type ScanEvent =
  { type: "highlight"; id: string | null } | { type: "select"; id: string } | { type: "paused" };

export class ScanEngine {
  private config: ScanConfig;
  private items: string[] = [];
  private index = -1;
  private nextAt = 0;
  private passes = 0;
  private paused = false;

  constructor(config: Partial<ScanConfig> = {}) {
    this.config = { ...DEFAULT_SCAN, ...config };
  }

  setConfig(config: Partial<ScanConfig>): void {
    this.config = { ...this.config, ...config };
  }

  get highlighted(): string | null {
    return this.index >= 0 ? (this.items[this.index] ?? null) : null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Replace the scannable items (e.g. when the screen changes). Keeps the highlight if still present. */
  setItems(ids: string[], now: number): ScanEvent[] {
    const same = ids.length === this.items.length && ids.every((id, i) => id === this.items[i]);
    if (same) return [];
    const keep = this.highlighted;
    this.items = ids;
    if (keep && ids.includes(keep)) {
      this.index = ids.indexOf(keep);
      return [];
    }
    return this.restart(now);
  }

  restart(now: number): ScanEvent[] {
    this.paused = false;
    this.passes = 0;
    this.index = this.items.length ? 0 : -1;
    this.nextAt = now + this.config.intervalMs + this.config.firstItemExtraMs;
    return [{ type: "highlight", id: this.highlighted }];
  }

  tick(now: number): ScanEvent[] {
    if (this.paused || this.items.length === 0 || now < this.nextAt) return [];
    this.index += 1;
    if (this.index >= this.items.length) {
      this.index = 0;
      this.passes += 1;
      if (this.passes >= this.config.maxPasses) {
        this.paused = true;
        this.index = -1;
        return [{ type: "paused" }, { type: "highlight", id: null }];
      }
    }
    this.nextAt = now + this.config.intervalMs + (this.index === 0 ? this.config.firstItemExtraMs : 0);
    return [{ type: "highlight", id: this.highlighted }];
  }

  /** A switch press. Selects the highlighted item, or restarts a paused scan. */
  press(now: number): ScanEvent[] {
    if (this.paused || this.highlighted === null) return this.restart(now);
    const id = this.highlighted;
    this.passes = 0;
    this.index = 0;
    this.nextAt = now + this.config.intervalMs + this.config.firstItemExtraMs * 2;
    return [{ type: "select", id }];
  }
}
