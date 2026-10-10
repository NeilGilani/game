import { describe, expect, it } from "vitest";
import { DwellEngine, type DwellEvent, type DwellSample } from "../src/input/dwell";

const cfg = {
  dwellMs: 1000,
  stabilityPx: 40,
  stabilityWindowMs: 200,
  graceMs: 200,
  refractoryMs: 800,
  minConfidence: 0.5,
};

function run(
  engine: DwellEngine,
  from: number,
  to: number,
  sample: Omit<DwellSample, "t">,
  step = 33,
): DwellEvent[] {
  const events: DwellEvent[] = [];
  for (let t = from; t <= to; t += step) events.push(...engine.update({ ...sample, t }));
  return events;
}
const activations = (events: DwellEvent[]) => events.filter((e) => e.type === "activate");

describe("dwell selection", () => {
  it("selects after the dwell time on a steady target", () => {
    const e = new DwellEngine(cfg);
    const ev = run(e, 0, 1100, { x: 100, y: 100, confidence: 0.9, targetId: "approve" });
    expect(activations(ev)).toEqual([{ type: "activate", targetId: "approve" }]);
  });

  it("does not select on a brief pass over a button", () => {
    const e = new DwellEngine(cfg);
    const ev = [
      ...run(e, 0, 400, { x: 100, y: 100, confidence: 0.9, targetId: "approve" }),
      ...run(e, 433, 2000, { x: 600, y: 100, confidence: 0.9, targetId: null }),
    ];
    expect(activations(ev)).toHaveLength(0);
    expect(ev.some((x) => x.type === "cancel")).toBe(true);
  });

  it("does not repeat while the gaze stays on the selected target", () => {
    const e = new DwellEngine(cfg);
    const ev = run(e, 0, 5000, { x: 100, y: 100, confidence: 0.9, targetId: "next" });
    expect(activations(ev)).toHaveLength(1);
    expect(ev.some((x) => x.type === "blocked" && x.reason === "spent")).toBe(true);
  });

  it("can select the same target again after leaving and returning", () => {
    const e = new DwellEngine(cfg);
    const ev = [
      ...run(e, 0, 1100, { x: 100, y: 100, confidence: 0.9, targetId: "next" }),
      ...run(e, 1133, 1600, { x: 600, y: 100, confidence: 0.9, targetId: null }),
      ...run(e, 1633, 2900, { x: 100, y: 100, confidence: 0.9, targetId: "next" }),
    ];
    expect(activations(ev)).toHaveLength(2);
  });

  it("requires a steady pointer: jitter larger than the stability radius stalls progress", () => {
    const e = new DwellEngine(cfg);
    const events: DwellEvent[] = [];
    for (let t = 0; t < 3000; t += 33) {
      const x = 100 + (Math.floor(t / 33) % 2 === 0 ? -60 : 60);
      events.push(...e.update({ t, x, y: 100, confidence: 0.9, targetId: "approve" }));
    }
    expect(activations(events)).toHaveLength(0);
  });

  it("pauses (not resets) during a short blink, and cancels if tracking is lost", () => {
    const e = new DwellEngine(cfg);
    const blink = [
      ...run(e, 0, 600, { x: 100, y: 100, confidence: 0.9, targetId: "a" }),
      ...run(e, 633, 750, { x: 100, y: 100, confidence: 0.1, targetId: "a" }),
      ...run(e, 783, 1300, { x: 100, y: 100, confidence: 0.9, targetId: "a" }),
    ];
    expect(activations(blink)).toHaveLength(1);

    const e2 = new DwellEngine(cfg);
    const lost = [
      ...run(e2, 0, 600, { x: 100, y: 100, confidence: 0.9, targetId: "a" }),
      ...run(e2, 633, 1500, { x: 100, y: 100, confidence: 0.0, targetId: "a" }),
    ];
    expect(lost.some((x) => x.type === "cancel" && x.reason === "tracking-lost")).toBe(true);
    expect(activations(lost)).toHaveLength(0);
  });

  it("blocks any selection during the refractory period (e.g. after a screen change)", () => {
    const e = new DwellEngine(cfg);
    e.reset(0, 2000);
    const ev = run(e, 0, 2500, { x: 100, y: 100, confidence: 0.9, targetId: "confirm" });
    expect(activations(ev)).toHaveLength(0);
    const later = run(e, 2533, 4000, { x: 100, y: 100, confidence: 0.9, targetId: "confirm" });
    expect(activations(later)).toHaveLength(1);
  });

  it("honours a longer dwell for protected targets", () => {
    const e = new DwellEngine(cfg);
    const short = run(e, 0, 1500, { x: 100, y: 100, confidence: 0.9, targetId: "resume", dwellScale: 2 });
    expect(activations(short)).toHaveLength(0);
    const rest = run(e, 1533, 2200, { x: 100, y: 100, confidence: 0.9, targetId: "resume", dwellScale: 2 });
    expect(activations(rest)).toHaveLength(1);
  });
});
