import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTENT,
  HeadingPredictor,
  IntentSelector,
  type IntentSelectorTarget,
  type IntentTarget,
  PrecisionMeter,
  chooseTarget,
  effectivePrior,
  posterior,
  precisionFor,
} from "../src/input/intent";
import { findTarget } from "../src/input/targets";
import { rng } from "../src/linalg";

const box = (
  id: string,
  left: number,
  top: number,
  size = 96,
  extra: Partial<IntentTarget> = {},
): IntentTarget => ({
  id,
  rect: { left, top, right: left + size, bottom: top + size },
  ...extra,
});

// Two 96 px targets with a 24 px gap: "back" on the left, "order" on the right.
const pair = (priors: { back?: number; order?: number } = {}, extra: Partial<IntentTarget> = {}) => [
  box("back", 100, 100, 96, { prior: priors.back }),
  box("order", 220, 100, 96, { prior: priors.order, ...extra }),
];

describe("intent: gaze likelihood x context prior", () => {
  it("is exactly the old snap hit-test when every prior is neutral", () => {
    const r = rng(7);
    const targets: IntentTarget[] = [];
    for (let i = 0; i < 6; i++)
      targets.push(box(`t${i}`, 40 + (i % 3) * 120, 40 + Math.floor(i / 3) * 120, 96));
    targets.push(box("small", 400, 400, 30));
    for (let i = 0; i < 2000; i++) {
      const x = r() * 600;
      const y = r() * 600;
      const errorRadius = r() * 200;
      expect(chooseTarget(x, y, errorRadius, targets, { snapPx: 48 })).toBe(findTarget(x, y, targets, 48));
    }
  });

  it("is the old snap at strength 0, whatever the priors", () => {
    const targets = pair({ order: 3 });
    for (let x = 150; x <= 320; x += 5) {
      expect(chooseTarget(x, 150, 160, targets, { strength: 0 })).toBe(findTarget(x, 150, targets, 48));
    }
  });

  it("lets a likely target win the gap between two targets when tracking is rough", () => {
    // 4 px left of the gap's middle: plain hit-testing says "back".
    expect(findTarget(204, 150, pair(), 48)).toBe("back");
    expect(chooseTarget(204, 150, 120, pair({ order: 2 }))).toBe("order");
  });

  it("lets the eyes decide when tracking is sharp", () => {
    // Same spot, sharp tracking (error radius 16 px): the prior can't overturn 4 px of evidence... unless
    // the evidence is that weak. 20 px inside "back" must stay "back".
    expect(chooseTarget(176, 150, 16, pair({ order: 3 }))).toBe("back");
    // And the posterior is confident about it.
    const post = posterior(176, 150, 16, pair({ order: 3 }));
    expect(post[0]!.id).toBe("back");
    expect(post[0]!.p).toBeGreaterThan(0.99);
  });

  it("never reaches beyond maxReachPx, however likely the target", () => {
    const far = [box("only", 0, 0, 96, { prior: 3 })];
    expect(chooseTarget(96 + 97, 48, 400, far)).toBeNull();
    expect(chooseTarget(96 + 60, 48, 400, far)).toBe("only");
    // With a neutral prior the same spot is out of reach (the old 48 px snap).
    expect(chooseTarget(96 + 60, 48, 400, [box("only", 0, 0, 96)])).toBeNull();
  });

  it("never boosts an approval gate", () => {
    expect(
      effectivePrior({ id: "a", rect: { left: 0, top: 0, right: 1, bottom: 1 }, prior: 3, gate: true }),
    ).toBe(1);
    expect(chooseTarget(204, 150, 120, pair({ order: 3 }, { gate: true }))).toBe("back");
  });

  it("never lets context make Stop or Help harder to reach", () => {
    // "stop" sits next to a likely "order"; the pointer is in the gap, 4 px nearer to stop.
    const targets = [box("stop", 100, 100, 96, { protect: true }), box("order", 220, 100, 96, { prior: 3 })];
    expect(chooseTarget(204, 150, 120, targets)).toBe("stop");
    // Without the protection the likely target would take it.
    expect(
      chooseTarget(204, 150, 120, [box("stop", 100, 100, 96), box("order", 220, 100, 96, { prior: 3 })]),
    ).toBe("order");
  });

  it("clamps priors and ignores nonsense", () => {
    const t = (prior: number) => ({ id: "a", rect: { left: 0, top: 0, right: 1, bottom: 1 }, prior });
    expect(effectivePrior(t(100))).toBe(DEFAULT_INTENT.priorMax);
    expect(effectivePrior(t(0.01))).toBe(DEFAULT_INTENT.priorMin);
    expect(effectivePrior(t(Number.NaN))).toBe(1);
    expect(effectivePrior(t(-2))).toBe(1);
  });

  it("gives a posterior that sums to one and includes 'nothing'", () => {
    const post = posterior(204, 150, 120, pair({ order: 2 }));
    expect(post.reduce((s, h) => s + h.p, 0)).toBeCloseTo(1, 10);
    expect(post.some((h) => h.id === null)).toBe(true);
    expect(post[0]!.id).toBe("order");
    // Far from everything: nothing wins.
    expect(posterior(800, 800, 120, pair({ order: 3 }))[0]!.id).toBeNull();
  });

  it("an unlikely target (prior below 1) needs the eyes closer", () => {
    // 40 px outside "back" on the far side from "order": in reach of the old snap, not when unlikely.
    expect(chooseTarget(60, 150, 120, pair({ back: 1 }))).toBe("back");
    expect(chooseTarget(60, 150, 120, pair({ back: 0.5 }))).toBeNull();
  });
});

describe("intent: heading prediction", () => {
  const targets = [
    box("next", 600, 100, 120, { prior: 2 }),
    box("pay", 600, 400, 120, { prior: 3, consequential: true }),
  ];

  const move = (
    p: HeadingPredictor,
    from: { x: number; y: number },
    to: { x: number; y: number },
    t0 = 0,
  ) => {
    let out: string | null = null;
    for (let i = 0; i <= 6; i++) {
      const k = i / 6;
      out = p.update(
        { t: t0 + i * 33, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, confidence: 1 },
        targets,
      );
    }
    return out;
  };

  it("pre-highlights a likely target the pointer is heading towards", () => {
    const p = new HeadingPredictor();
    expect(move(p, { x: 100, y: 160 }, { x: 400, y: 160 })).toBe("next");
    expect(p.dwellScaleFor(targets[0], 220)).toBe(0.75);
  });

  it("never predicts a consequential target, and never shortens its dwell", () => {
    const p = new HeadingPredictor();
    expect(move(p, { x: 100, y: 460 }, { x: 400, y: 460 })).toBeNull();
    expect(p.dwellScaleFor(targets[1], 220)).toBe(1);
  });

  it("doesn't predict from a slow drift or a still pointer", () => {
    const p = new HeadingPredictor();
    expect(move(p, { x: 100, y: 160 }, { x: 130, y: 160 })).toBeNull();
  });

  it("doesn't predict a target off the direction of travel", () => {
    const p = new HeadingPredictor();
    expect(move(p, { x: 400, y: 160 }, { x: 100, y: 160 })).toBeNull();
  });

  it("expires the prediction after holdMs", () => {
    const p = new HeadingPredictor({ holdMs: 300 });
    move(p, { x: 100, y: 160 }, { x: 400, y: 160 });
    expect(p.current(198 + 299)).toBe("next");
    expect(p.current(198 + 301)).toBeNull();
    expect(p.dwellScaleFor(targets[0], 198 + 301)).toBe(1);
  });

  it("ignores low-confidence frames", () => {
    const p = new HeadingPredictor();
    for (let i = 0; i <= 6; i++) p.update({ t: i * 33, x: 100 + i * 50, y: 160, confidence: 0.2 }, targets);
    expect(p.current(200)).toBeNull();
  });

  it("only predicts targets that are likely enough", () => {
    const p = new HeadingPredictor();
    const neutral = [box("next", 600, 100, 120)];
    let out: string | null = null;
    for (let i = 0; i <= 6; i++)
      out = p.update({ t: i * 33, x: 100 + i * 50, y: 160, confidence: 1 }, neutral);
    expect(out).toBeNull();
  });
});

describe("intent: precision level for adaptive layout", () => {
  it("maps the error radius to a level with hysteresis", () => {
    expect(precisionFor(40, "normal")).toBe("sharp");
    expect(precisionFor(90, "normal")).toBe("normal");
    expect(precisionFor(140, "normal")).toBe("rough");
    // Near a threshold the current level stays.
    expect(precisionFor(125, "normal")).toBe("normal");
    expect(precisionFor(115, "rough")).toBe("rough");
    expect(precisionFor(105, "rough")).toBe("normal");
    expect(precisionFor(65, "sharp")).toBe("sharp");
  });

  it("changes level only after the new level has held", () => {
    const m = new PrecisionMeter({ holdMs: 3000, smoothingMs: 500 });
    let t = 0;
    for (; t < 2000; t += 33) m.update(t, 90);
    expect(m.level).toBe("normal");
    // Tracking gets rough.
    for (; t < 4000; t += 33) m.update(t, 200);
    expect(m.level).toBe("normal");
    for (; t < 8000; t += 33) m.update(t, 200);
    expect(m.level).toBe("rough");
    // One good second doesn't make it sharp.
    for (; t < 9000; t += 33) m.update(t, 30);
    expect(m.level).toBe("rough");
    for (; t < 14000; t += 33) m.update(t, 30);
    expect(m.level).toBe("sharp");
  });

  it("ignores a brief spike", () => {
    const m = new PrecisionMeter();
    let t = 0;
    for (; t < 5000; t += 33) m.update(t, 80);
    for (; t < 5300; t += 33) m.update(t, 400);
    for (; t < 10000; t += 33) m.update(t, 80);
    expect(m.level).toBe("normal");
  });
});

describe("intent: selection with dwell", () => {
  const dwell = { dwellMs: 1200, stabilityPx: 60, refractoryMs: 0 };

  /** Look at empty space (x0, y) for 600 ms, jump to (x1, y) in two frames, then hold there; returns when it selected. */
  function lookAndJump(
    sel: IntentSelector,
    targets: IntentSelectorTarget[],
    x0: number,
    x1: number,
    y: number,
  ) {
    let t = 0;
    for (; t < 600; t += 33) sel.update({ t, x: x0, y, confidence: 1, errorRadius: 80 }, targets);
    sel.update({ t, x: (x0 + x1) / 2, y, confidence: 1, errorRadius: 80 }, targets);
    t += 33;
    const arrived = t;
    for (; t < 4000; t += 33) {
      const u = sel.update({ t, x: x1, y, confidence: 1, errorRadius: 80 }, targets);
      const done = u.events.find((e) => e.type === "activate");
      if (done) return { id: done.targetId, after: t - arrived };
    }
    return null;
  }

  it("selects after the full dwell with neutral priors (as before)", () => {
    const sel = new IntentSelector({ dwell });
    const r = lookAndJump(sel, [box("a", 100, 100, 120), box("b", 700, 100, 120)], 400, 760, 160);
    expect(r?.id).toBe("b");
    expect(r!.after).toBeGreaterThanOrEqual(1150);
  });

  it("shortens the dwell when the eyes jump to a likely, safe target", () => {
    const sel = new IntentSelector({ dwell });
    const r = lookAndJump(
      sel,
      [box("a", 100, 100, 120), box("b", 700, 100, 120, { prior: 2 })],
      400,
      760,
      160,
    );
    expect(r?.id).toBe("b");
    expect(r!.after).toBeLessThan(1000);
    expect(r!.after).toBeGreaterThanOrEqual(850);
  });

  it("keeps the full dwell for a likely target that pays, sends or shares", () => {
    const sel = new IntentSelector({ dwell });
    const targets = [box("a", 100, 100, 120), box("b", 700, 100, 120, { prior: 2, consequential: true })];
    const r = lookAndJump(sel, targets, 400, 760, 160);
    expect(r?.id).toBe("b");
    expect(r!.after).toBeGreaterThanOrEqual(1150);
  });

  it("keeps the full dwell with prediction switched off", () => {
    const sel = new IntentSelector({ dwell, prediction: false });
    const r = lookAndJump(
      sel,
      [box("a", 100, 100, 120), box("b", 700, 100, 120, { prior: 2 })],
      400,
      760,
      160,
    );
    expect(r!.after).toBeGreaterThanOrEqual(1150);
  });

  it("doesn't shorten a dwell on a likely target the eyes drifted onto slowly", () => {
    const sel = new IntentSelector({ dwell });
    const targets = [box("b", 300, 100, 120, { prior: 3 })];
    let t = 0;
    let x = 200;
    let selectedAt: number | null = null;
    let enteredAt: number | null = null;
    for (; t < 5000 && selectedAt === null; t += 33) {
      x = Math.min(360, x + 2); // 60 px/s
      const u = sel.update({ t, x, y: 160, confidence: 1, errorRadius: 80 }, targets);
      for (const e of u.events) {
        if (e.type === "enter") enteredAt = t;
        if (e.type === "activate") selectedAt = t;
      }
    }
    expect(selectedAt! - enteredAt!).toBeGreaterThanOrEqual(1150);
  });
});
