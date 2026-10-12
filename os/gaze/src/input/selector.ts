/**
 * Hands-free selection with a pointer (calibrated gaze or the head pointer): target magnetism
 * (magnet.ts) decides which target is meant, dwell (dwell.ts) decides when it is selected. The web
 * app's InputLayer feeds it camera frames and the page's targets; the benchmark feeds it simulated
 * frames, so both run the same logic.
 *
 * When the magnet moves its lock to another target it has already waited for clear evidence, so the
 * old target's dwell ends at once instead of after the dwell's grace period. When the lock is merely
 * released (a glance away), the dwell pauses: if the lock comes back to the same target within the
 * dwell's grace period, the ring carries on from where it was. Everything else (confidence,
 * refractory period, a selected target not firing again until the eyes leave it) is the dwell
 * engine's rules.
 */

import { type DwellConfig, DwellEngine, type DwellEvent } from "./dwell";
import { type MagnetOptions, type MagnetResult, TargetMagnet, rectCentre } from "./magnet";
import type { TargetRect } from "./targets";

export interface SelectorTarget extends TargetRect {
  /** Some targets ask for a longer dwell (e.g. 2 for "Resume eye control"). */
  dwellScale?: number;
  /**
   * The target just appeared, moved or resized (e.g. AI suggestions arriving under the gaze): it can be
   * highlighted, but its dwell doesn't fill until it has held still.
   */
  settling?: boolean;
}

export interface SelectorSample {
  t: number;
  x: number;
  y: number;
  confidence: number;
  /** About two standard deviations of the pointer's error (px); 0 when precise or unknown. */
  errorRadius?: number;
}

export type SelectorEvent =
  | DwellEvent
  /** The highlighted target changed (null: nothing is highlighted). */
  | { type: "lock"; targetId: string | null; previous: string | null }
  /** A dwell completed: `dwellStartT` is when the dwell on this target began (for recalibration). */
  | { type: "selected"; targetId: string; t: number; dwellStartT: number };

/**
 * What the dwell's steadiness rule measures. "pointer": the pointer must hold within stabilityPx;
 * "lock": the lock itself is the evidence (the magnet's reach and hysteresis already absorb the
 * estimate's wobble); "adaptive": the pointer, within the larger of stabilityPx and the error radius.
 */
export type Steadiness = "pointer" | "lock" | "adaptive";

export interface SelectorOptions {
  dwell: Partial<DwellConfig>;
  magnet: Partial<MagnetOptions>;
  steadiness: Steadiness;
  /** Pause dwell progress on frames whose estimate doesn't support the lock (see MagnetResult). */
  weighted: boolean;
}

/**
 * How the web app's InputLayer sets the selector up (the person's dwell time, steadiness and snap
 * preferences go on top). Steadiness reads the lock, as the cursor does: a noisy but on-target gaze
 * fills the ring without stalling, and frames that don't support the lock pause it instead. In
 * bench/app.bench.ts the three steadiness rules select the same, and false selections while reading
 * stay near zero.
 */
export const APP_SELECTOR: Partial<SelectorOptions> = {
  dwell: { dwellMs: 1200, stabilityPx: 60 },
  magnet: { snapPx: 48 },
  steadiness: "lock",
};

export class GazeSelector {
  readonly magnet: TargetMagnet;
  readonly dwell: DwellEngine;
  private steadiness: Steadiness;
  private weighted: boolean;
  private stabilityPx: number;
  private entered: { id: string; t: number } | null = null;
  private lastMagnet: MagnetResult | null = null;

  constructor(options: Partial<SelectorOptions> = {}) {
    this.magnet = new TargetMagnet(options.magnet);
    this.dwell = new DwellEngine(options.dwell);
    this.steadiness = options.steadiness ?? "pointer";
    this.weighted = options.weighted ?? true;
    this.stabilityPx = options.dwell?.stabilityPx ?? 60;
  }

  setOptions(options: Partial<SelectorOptions>): void {
    if (options.magnet) this.magnet.setOptions(options.magnet);
    if (options.dwell) {
      this.dwell.setConfig(options.dwell);
      if (options.dwell.stabilityPx !== undefined) this.stabilityPx = options.dwell.stabilityPx;
    }
    if (options.steadiness) this.steadiness = options.steadiness;
  }

  /** The highlighted target, if any. */
  get locked(): string | null {
    return this.magnet.current;
  }

  /** Where to draw the cursor after the last update: the locked target's centre, else the estimate. */
  get cursor(): { x: number; y: number } | null {
    return this.lastMagnet?.cursor ?? null;
  }

  /** Whether the last update's estimate supported the lock (false: the dwell is paused). */
  get supported(): boolean {
    return this.lastMagnet?.supported ?? false;
  }

  /** Forget the lock and any dwell, and block selection for holdMs (e.g. after navigation). */
  reset(now: number, holdMs?: number): void {
    this.magnet.reset();
    this.dwell.reset(now, holdMs);
    this.entered = null;
    this.lastMagnet = null;
  }

  update(s: SelectorSample, targets: readonly SelectorTarget[]): SelectorEvent[] {
    const events: SelectorEvent[] = [];
    const previous = this.magnet.current;
    const m = this.magnet.update(s, targets);
    this.lastMagnet = m;
    if (m.changed) {
      events.push({ type: "lock", targetId: m.targetId, previous });
      const dwelling = this.dwell.snapshot().targetId;
      if (dwelling !== null && m.targetId !== null && dwelling !== m.targetId) {
        events.push({ type: "cancel", targetId: dwelling, reason: "left" });
        this.dwell.reset(s.t, 0);
        this.entered = null;
      }
    }
    const target = m.targetId === null ? undefined : targets.find((t) => t.id === m.targetId);
    let x = s.x;
    let y = s.y;
    if (this.steadiness === "lock" && target) ({ x, y } = rectCentre(target.rect));
    if (this.steadiness === "adaptive") {
      this.dwell.setConfig({ stabilityPx: Math.max(this.stabilityPx, s.errorRadius ?? 0) });
    }
    const dwellEvents = this.dwell.update({
      t: s.t,
      x,
      y,
      confidence: s.confidence,
      targetId: m.targetId,
      dwellScale: target?.dwellScale ?? 1,
      weight: (!this.weighted || m.supported) && !target?.settling ? 1 : 0,
    });
    for (const e of dwellEvents) {
      events.push(e);
      if (e.type === "enter") this.entered = { id: e.targetId, t: s.t };
      else if (e.type === "cancel") this.entered = null;
      else if (e.type === "activate") {
        const dwellStartT = this.entered?.id === e.targetId ? this.entered.t : s.t;
        events.push({ type: "selected", targetId: e.targetId, t: s.t, dwellStartT });
        this.entered = null;
      }
    }
    return events;
  }
}
