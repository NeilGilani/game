import { describe, expect, it } from "vitest";
import { HelpPattern, type PatternState } from "../src/lifeline/pattern";

const FRAME = 33;

/** Feed a sequence of [durationMs, score] segments at ~30 fps; return every state. */
function feed(
  p: HelpPattern,
  segments: [number, number | null][],
  start = 0,
): { states: PatternState[]; t: number } {
  const states: PatternState[] = [];
  let t = start;
  for (const [ms, score] of segments) {
    const end = t + ms;
    for (; t < end; t += FRAME) states.push(p.update(t, score));
  }
  return { states, t };
}

const OPEN = 0.05;
const SHUT = 0.9;
const longBlink = (ms = 1000): [number, number][] => [
  [ms, SHUT],
  [700, OPEN],
];

describe("HelpPattern (three long blinks)", () => {
  it("fires once on three deliberate closures", () => {
    const p = new HelpPattern();
    const { states } = feed(p, [[500, OPEN], ...longBlink(), ...longBlink(), ...longBlink()]);
    expect(states.filter((s) => s.fired)).toHaveLength(1);
    expect(Math.max(...states.map((s) => s.counted))).toBe(3);
  });

  it("ignores ordinary blinks, even many of them", () => {
    const p = new HelpPattern();
    const blinks: [number, number][] = [];
    for (let i = 0; i < 20; i++) blinks.push([200, SHUT], [500, OPEN]);
    const { states } = feed(p, blinks);
    expect(states.some((s) => s.fired)).toBe(false);
    expect(Math.max(...states.map((s) => s.counted))).toBe(0);
  });

  it("ordinary blinks between long ones don't break the pattern", () => {
    const p = new HelpPattern();
    const { states } = feed(p, [
      ...longBlink(),
      [200, SHUT],
      [400, OPEN],
      ...longBlink(),
      [150, SHUT],
      [400, OPEN],
      ...longBlink(),
    ]);
    expect(states.filter((s) => s.fired)).toHaveLength(1);
  });

  it("two long blinks are not enough", () => {
    const p = new HelpPattern();
    const { states } = feed(p, [...longBlink(), ...longBlink(), [5000, OPEN]]);
    expect(states.some((s) => s.fired)).toBe(false);
  });

  it("long blinks spread over more than ten seconds don't fire", () => {
    const p = new HelpPattern();
    const { states } = feed(p, [...longBlink(), [4500, OPEN], ...longBlink(), [4500, OPEN], ...longBlink()]);
    expect(states.some((s) => s.fired)).toBe(false);
  });

  it("closing the eyes to rest resets the count", () => {
    const p = new HelpPattern();
    const { states } = feed(p, [...longBlink(), ...longBlink(), [4000, SHUT], [500, OPEN], ...longBlink()]);
    expect(states.some((s) => s.fired)).toBe(false);
    expect(states.at(-1)?.counted).toBe(1);
  });

  it("losing the face is never read as a closed eye and resets the count", () => {
    const p = new HelpPattern();
    const lost = feed(p, [[3000, null]]);
    expect(lost.states.every((s) => !s.closed && s.counted === 0)).toBe(true);
    const { states } = feed(p, [...longBlink(), ...longBlink(), [500, null], ...longBlink()], lost.t);
    expect(states.some((s) => s.fired)).toBe(false);
  });

  it("does not fire again straight away (refractory period)", () => {
    const p = new HelpPattern();
    const first = feed(p, [...longBlink(), ...longBlink(), ...longBlink()]);
    const again = feed(p, [...longBlink(), ...longBlink(), ...longBlink()], first.t);
    expect(first.states.filter((s) => s.fired)).toHaveLength(1);
    expect(again.states.some((s) => s.fired)).toBe(false);
    const later = feed(p, [[4000, OPEN], ...longBlink(), ...longBlink(), ...longBlink()], again.t);
    expect(later.states.filter((s) => s.fired)).toHaveLength(1);
  });

  it("reports hold progress while the eyes are closed", () => {
    const p = new HelpPattern();
    const { states } = feed(p, [[300, SHUT]]);
    const last = states.at(-1)!;
    expect(last.closed).toBe(true);
    expect(last.holdProgress).toBeGreaterThan(0.4);
    expect(last.holdProgress).toBeLessThan(0.6);
  });

  it("uses hysteresis so a flickering score near the threshold isn't many blinks", () => {
    const p = new HelpPattern();
    const flicker: [number, number][] = [];
    for (let i = 0; i < 30; i++) flicker.push([FRAME, 0.6], [FRAME, 0.45]);
    const { states } = feed(p, [...flicker, [700, OPEN]]);
    // One continuous ~2 s closure: counted once, not thirty times.
    expect(Math.max(...states.map((s) => s.counted))).toBe(1);
  });
});
