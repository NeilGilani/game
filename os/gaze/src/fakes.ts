/**
 * Fakes for the other instances: develop the overlay, shell and flows without a camera.
 *
 * - MouseProvider (providers/mouse.ts): the mouse is the gaze.
 * - ReplayProvider (providers/replay.ts): replays a landmark recording through the real engine.
 * - FakeGazeSource (here): emits contract GazeEvents from a script, no engine at all, for unit
 *   tests of consumers (dwell rings, pickers, Lifeline's meter).
 */

import type { GazeEvent } from "./contracts";

export type FakeStep =
  | { kind: "look"; x: number; y: number; ms: number; confidence?: number }
  | { kind: "lose-face"; ms: number }
  | { kind: "long-blinks"; count: number; holdMs?: number; gapMs?: number };

/** Turn a script into a timed list of GazeEvents at `hz`. Deterministic. */
export function fakeGazeEvents(
  steps: readonly FakeStep[],
  options: { hz?: number; startT?: number } = {},
): GazeEvent[] {
  const dt = 1000 / (options.hz ?? 30);
  let t = options.startT ?? 0;
  const out: GazeEvent[] = [];
  let last = { x: 0, y: 0 };
  for (const step of steps) {
    if (step.kind === "look") {
      const end = t + step.ms;
      let first = true;
      for (; t < end; t += dt) {
        out.push({
          type: "sample",
          sample: {
            t,
            x: step.x,
            y: step.y,
            confidence: step.confidence ?? 1,
            fixation: !first,
            source: "mouse",
          },
        });
        first = false;
      }
      last = { x: step.x, y: step.y };
    } else if (step.kind === "lose-face") {
      out.push({ type: "tracking", t, state: "weak" });
      const end = t + step.ms;
      for (; t < end; t += dt) {
        out.push({ type: "blink", t, score: null, face: false });
        out.push({
          type: "sample",
          sample: { t, x: last.x, y: last.y, confidence: 0, fixation: false, source: "mouse" },
        });
      }
      out.push({ type: "tracking", t, state: "ok" });
    } else {
      const hold = step.holdMs ?? 1000;
      const gap = step.gapMs ?? 700;
      for (let i = 1; i <= step.count; i++) {
        out.push({ type: "blink", t, score: 0.9, face: true });
        t += hold;
        out.push({ type: "blink", t, score: 0.05, face: true });
        out.push({ type: "help-progress", t, counted: Math.min(i, 3) });
        if (i === 3) out.push({ type: "help-signal", t });
        t += gap;
      }
    }
  }
  return out;
}

/** Play scripted events to a listener in real time (or instantly with speed = Infinity). */
export class FakeGazeSource {
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly events: readonly GazeEvent[]) {}

  play(listener: (e: GazeEvent) => void, speed = 1): void {
    this.stop();
    if (!Number.isFinite(speed)) {
      this.events.forEach(listener);
      return;
    }
    const t0 = eventTime(this.events[0]);
    for (const e of this.events) {
      this.timers.push(setTimeout(() => listener(e), (eventTime(e) - t0) / speed));
    }
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}

function eventTime(e: GazeEvent | undefined): number {
  if (!e) return 0;
  if (e.type === "sample") return e.sample.t;
  if (e.type === "calibration") return 0;
  return e.t;
}
