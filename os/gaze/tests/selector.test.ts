/**
 * Locked-in selection: target magnetism (magnet.ts) plus dwell (dwell.ts) through GazeSelector, set up
 * as the web app's InputLayer sets it up (dwell 1200 ms, 60 px steadiness, 48 px snap). Gaze is
 * SIMULATED: a fixed offset plus Gaussian noise at 30 frames a second, many seeds per scenario.
 */
import { describe, expect, it } from "vitest";
import { TargetMagnet, targetLikelihood } from "../src/input/magnet";
import { APP_SELECTOR, GazeSelector, type SelectorEvent, type SelectorTarget } from "../src/input/selector";
import { gaussian, rng } from "../src/linalg";

const SIZE = 96;
const GAP = 24;
const FRAME_MS = 33;
const SEEDS = 20;

/** A 3 x 3 grid of AGENCY's smallest buttons (96 px, 24 px apart); "c" is the middle one. */
const ids = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"];
const targets: SelectorTarget[] = ids.map((id, i) => {
  const left = 400 + (i % 3) * (SIZE + GAP);
  const top = 300 + Math.floor(i / 3) * (SIZE + GAP);
  return { id, rect: { left, top, right: left + SIZE, bottom: top + SIZE } };
});
const centre = (id: string) => {
  const r = targets.find((t) => t.id === id)!.rect;
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
};

/** Gaze noise as the engine reports it: per-axis sd, a constant offset, and the error radius (about 2 sd). */
const NOISE = { sd: 22, offset: { x: 14, y: -10 }, errorRadius: 60 };

interface Look {
  /** Where the eyes are; null with low confidence (a blink). */
  at: { x: number; y: number } | null;
  ms: number;
}

/** Feed a sequence of looks to the selector; returns every event with its time. */
function play(selector: GazeSelector, looks: Look[], seed: number, t0 = 0) {
  const r = rng(seed);
  const out: { t: number; e: SelectorEvent }[] = [];
  let t = t0;
  for (const look of looks) {
    const end = t + look.ms;
    for (; t < end; t += FRAME_MS) {
      const sample = look.at
        ? {
            t,
            x: look.at.x + NOISE.offset.x + NOISE.sd * gaussian(r),
            y: look.at.y + NOISE.offset.y + NOISE.sd * gaussian(r),
            confidence: 0.9,
            errorRadius: NOISE.errorRadius,
          }
        : { t, x: 0, y: 0, confidence: 0.1, errorRadius: NOISE.errorRadius };
      for (const e of selector.update(sample, targets)) out.push({ t, e });
    }
  }
  return { events: out, t };
}

const appSelector = () => new GazeSelector(APP_SELECTOR);
const selected = (events: { t: number; e: SelectorEvent }[]) =>
  events
    .filter((x) => x.e.type === "selected")
    .map((x) => ({ t: x.t, id: (x.e as { targetId: string }).targetId }));

describe("probabilistic target choice", () => {
  it("rates the target the estimate sits in above its neighbour, and both equal in the gap's middle", () => {
    const c = targets.find((t) => t.id === "c")!.rect;
    const e = targets.find((t) => t.id === "e")!.rect;
    const mid = (c.right + e.left) / 2;
    expect(targetLikelihood(centre("c").x, centre("c").y, 30, c)).toBeGreaterThan(
      20 * targetLikelihood(centre("c").x, centre("c").y, 30, e),
    );
    const a = targetLikelihood(mid, centre("c").y, 30, c);
    const b = targetLikelihood(mid, centre("c").y, 30, e);
    expect(Math.abs(a - b) / a).toBeLessThan(1e-6);
  });

  it("holds the locked target when the estimate wavers into the gap towards a neighbour", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const m = new TargetMagnet({ snapPx: 48 });
      const r = rng(seed);
      const c = centre("c");
      for (let t = 0; t < 600; t += FRAME_MS) {
        m.update(
          { t, x: c.x + 8 * gaussian(r), y: c.y + 8 * gaussian(r), confidence: 0.9, errorRadius: 60 },
          targets,
        );
      }
      expect(m.current).toBe("c");
      // A second of estimates centred on the gap between "c" and "e": the two are about equally likely.
      const midX = (targets[4]!.rect.right + targets[5]!.rect.left) / 2;
      for (let t = 600; t < 1600; t += FRAME_MS) {
        m.update(
          { t, x: midX + 8 * gaussian(r), y: c.y + 8 * gaussian(r), confidence: 0.9, errorRadius: 60 },
          targets,
        );
        expect(m.current).toBe("c");
      }
    }
  });

  it("puts the cursor in the middle of the locked target, not on the noisy estimate", () => {
    const s = appSelector();
    play(s, [{ at: centre("c"), ms: 400 }], 7);
    expect(s.locked).toBe("c");
    expect(s.cursor).toEqual(centre("c"));
  });
});

describe("locked-in dwell selection (simulated gaze)", () => {
  it("completes a dwell on a 96 px button under noisy gaze", () => {
    const times: number[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { events } = play(appSelector(), [{ at: centre("c"), ms: 3000 }], seed);
      const picks = selected(events);
      expect(picks.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(picks[0]!.id, `seed ${seed}`).toBe("c");
      // Never anything else: the lock doesn't flicker onto a neighbour.
      expect(
        events.filter((x) => x.e.type === "lock" && x.e.targetId !== "c" && x.e.targetId !== null),
      ).toEqual([]);
      times.push(picks[0]!.t);
    }
    // Lock (about 100 ms) plus the 1200 ms dwell, with a little lost to frames the estimate didn't support.
    expect(Math.max(...times)).toBeLessThan(2000);
  });

  it("doesn't reset the ring on a 200 ms glance away: it pauses and resumes", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const s = appSelector();
      const before = play(s, [{ at: centre("c"), ms: 700 }], seed);
      const kept = s.dwell.snapshot();
      expect(kept.targetId).toBe("c");
      expect(kept.progress).toBeGreaterThan(0.2);
      // Far off to the side (no target there) for 200 ms, then back.
      const away = play(s, [{ at: { x: 1300, y: 200 }, ms: 200 }], seed + 1000, before.t);
      const back = play(s, [{ at: centre("c"), ms: 2000 }], seed + 2000, away.t);
      const all = [...away.events, ...back.events];
      expect(
        all.filter((x) => x.e.type === "cancel"),
        `seed ${seed}`,
      ).toEqual([]);
      // The ring carries on from where it was within about 300 ms of the eyes coming back.
      const resumed = back.events.find(
        (x) => x.e.type === "progress" && x.e.targetId === "c" && x.e.progress > kept.progress,
      );
      expect(resumed, `seed ${seed}`).toBeDefined();
      expect(resumed!.t - away.t).toBeLessThanOrEqual(300);
      // And finishes in about the time that was left, not a whole new dwell.
      const pick = selected(back.events)[0];
      expect(pick?.id).toBe("c");
      expect(pick!.t - away.t).toBeLessThan(1200 * (1 - kept.progress) + 500);
    }
  });

  it("doesn't reset the ring on a blink", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const s = appSelector();
      const before = play(s, [{ at: centre("c"), ms: 700 }], seed);
      const kept = s.dwell.snapshot().progress;
      const blink = play(s, [{ at: null, ms: 150 }], seed, before.t);
      const back = play(s, [{ at: centre("c"), ms: 1500 }], seed + 2000, blink.t);
      expect([...blink.events, ...back.events].filter((x) => x.e.type === "cancel")).toEqual([]);
      expect(s.locked).toBe("c");
      const pick = selected(back.events)[0];
      expect(pick?.id).toBe("c");
      expect(pick!.t - blink.t).toBeLessThan(1200 * (1 - kept) + 500);
    }
  });

  it("does start over after a long look away", () => {
    const s = appSelector();
    const before = play(s, [{ at: centre("c"), ms: 700 }], 3);
    const away = play(s, [{ at: { x: 1300, y: 200 }, ms: 800 }], 4, before.t);
    expect(away.events.some((x) => x.e.type === "cancel" && x.e.targetId === "c")).toBe(true);
    expect(s.dwell.snapshot().progress).toBe(0);
  });

  it("switches to the neighbouring button on a deliberate look, and selects that one", () => {
    const switchTimes: number[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const s = appSelector();
      const first = play(s, [{ at: centre("c"), ms: 700 }], seed);
      expect(s.locked).toBe("c");
      const next = play(s, [{ at: centre("e"), ms: 2500 }], seed + 1000, first.t);
      const lock = next.events.find((x) => x.e.type === "lock" && x.e.targetId === "e");
      expect(lock, `seed ${seed}`).toBeDefined();
      switchTimes.push(lock!.t - first.t);
      expect(next.events.some((x) => x.e.type === "cancel" && x.e.targetId === "c")).toBe(true);
      const picks = [...selected(first.events), ...selected(next.events)];
      expect(
        picks.map((p) => p.id),
        `seed ${seed}`,
      ).toEqual(["e"]);
    }
    // Evidence smoothing (about 100 ms) plus the 200 ms switch time.
    expect(Math.max(...switchTimes)).toBeLessThan(500);
  });
});
