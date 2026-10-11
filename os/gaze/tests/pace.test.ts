/**
 * Pace: a simulated person tiring over a session. As they tire, their gaze wobbles more and brief
 * lapses (a drifting look, a slow blink) come more often. The dwell ring fills only on frames where
 * the gaze is on the target, and pauses through a lapse, as the dwell engine does, so tired
 * dwells take longer. All simulated.
 */
import { describe, expect, it } from "vitest";
import { type PaceChange, PaceMonitor } from "../src/input/pace";
import { gaussian, rng } from "../src/linalg";

const HALF_TARGET = 60;

/** One dwell of `dwellMs` by a person at `tiredness` 0..1: how long it took (ms), 30 fps frames. */
function dwellOnce(dwellMs: number, tiredness: number, rand: () => number): number {
  const wobble = 25 + 45 * tiredness;
  const lapseEvery = 2500 - 2000 * tiredness; // ms between brief lapses, on average
  let lapseUntil = -1;
  let filled = 0;
  let t = 0;
  while (filled < dwellMs && t < 10_000) {
    t += 33;
    if (t > lapseUntil && rand() < 33 / lapseEvery) lapseUntil = t + 160;
    const dx = gaussian(rand) * wobble;
    const dy = gaussian(rand) * wobble;
    const on = t >= lapseUntil && Math.abs(dx) < HALF_TARGET + 20 && Math.abs(dy) < HALF_TARGET + 20;
    if (on) filled += 33;
  }
  return t;
}

function session(
  tiredness: (i: number) => number,
  count: number,
  undoneAt: (i: number) => boolean = () => false,
) {
  const pace = new PaceMonitor();
  const rand = rng(5);
  const changes: (PaceChange & { at: number })[] = [];
  let t = 1000;
  for (let i = 0; i < count; i++) {
    const ms = dwellOnce(1200 * pace.state.dwellScale, tiredness(i), rand);
    t += ms + 1500;
    const c = pace.selected(t, ms);
    if (c) changes.push({ ...c, at: i });
    if (undoneAt(i)) {
      const u = pace.undone(t + 1200);
      if (u) changes.push({ ...u, at: i });
    }
  }
  return { changes, state: pace.state };
}

describe("pace: tiring over a session (simulated)", () => {
  it("gives a little more time and bigger targets as dwells get slower, and says so", () => {
    const { changes, state } = session((i) => Math.min(1, Math.max(0, (i - 20) / 25)), 70);
    console.log(
      "tiring person (simulated): " +
        changes.map((c) => `selection ${c.at}: level ${c.level} (${c.reason})`).join("; "),
    );
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0]!.at).toBeGreaterThan(20);
    expect(changes[0]!.message).toMatch(/more time and bigger targets/);
    expect(state.dwellScale).toBeGreaterThan(1);
    expect(state.dwellScale).toBeLessThanOrEqual(1.3);
    expect(state.targetScale).toBeGreaterThan(1);
    expect(state.targetScale).toBeLessThanOrEqual(1.25);
  });

  it("leaves a steady person alone, however slow their own pace", () => {
    for (const tiredness of [0, 0.6]) {
      const { changes } = session(() => tiredness, 60);
      expect(changes, `tiredness ${tiredness}`).toEqual([]);
    }
  });

  it("steps up when more selections get undone", () => {
    const { changes } = session(
      () => 0,
      40,
      (i) => i >= 16 && i % 3 === 0,
    );
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0]!.at).toBeGreaterThanOrEqual(16);
    expect(changes[0]!.reason).toMatch(/1\.[01]\dx as long.*[3-9]\d % of recent choices undone/);
  });

  it("steps back down only after a long run of easy selections", () => {
    const pace = new PaceMonitor();
    let t = 0;
    const feed = (ms: number, n: number) => {
      const out: PaceChange[] = [];
      for (let i = 0; i < n; i++) {
        t += 3000;
        const c = pace.selected(t, ms);
        if (c) out.push(c);
      }
      return out;
    };
    feed(1300, 8); // baseline
    expect(feed(1900, 10).map((c) => c.level)).toEqual([1]);
    // At the longer dwell an easy selection takes 1300 * 1.15.
    expect(feed(1500, 20)).toEqual([]);
    const down = feed(1500, 20);
    expect(down.map((c) => c.level)).toEqual([0]);
    expect(down[0]!.message).toMatch(/back to your settings/);
  });
});
