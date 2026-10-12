import { describe, expect, it } from "vitest";
import { APP_SELECTOR, GazeSelector, type SelectorTarget } from "../../os/gaze/src/input/selector";
import { contains, probePoints, SETTLE_MS, SettleGuard } from "../src/input/targetGuards";

const rect = (left: number, top: number, w = 100, h = 60) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

describe("only what can be seen can be chosen", () => {
  it("hit-tests a control at its centre and inside each corner, within the viewport", () => {
    const pts = probePoints(rect(100, 100), 1440, 900);
    expect(pts[0]).toEqual({ x: 150, y: 130 });
    expect(pts).toHaveLength(5);
    for (const p of pts) expect(contains(rect(100, 100), p)).toBe(true);
    // Half off the bottom of the screen: the points stay on screen.
    for (const p of probePoints(rect(100, 870), 1440, 900)) expect(p.y).toBeLessThanOrEqual(899);
  });
});

describe("new or moved controls hold still before they can be chosen", () => {
  it("a control is settling when it appears, moves or resizes, and not once it has held still", () => {
    const g = new SettleGuard();
    expect(g.update(0, [{ id: "a", rect: rect(0, 0) }]).has("a")).toBe(true);
    expect(g.update(SETTLE_MS - 1, [{ id: "a", rect: rect(0, 0) }]).has("a")).toBe(true);
    expect(g.update(SETTLE_MS, [{ id: "a", rect: rect(2, 3) }]).has("a")).toBe(false); // a wobble isn't a move
    // Shifted along by a suggestion that appeared before it: settling again.
    const moved = g.update(SETTLE_MS + 100, [
      { id: "new", rect: rect(0, 0) },
      { id: "a", rect: rect(120, 0) },
    ]);
    expect([...moved].sort()).toEqual(["a", "new"]);
    expect(g.update(2 * SETTLE_MS + 100, [{ id: "a", rect: rect(120, 0) }]).size).toBe(0);
  });

  it("a slow drift adds up to a move", () => {
    const g = new SettleGuard();
    g.update(0, [{ id: "a", rect: rect(0, 0) }]);
    // 3 px at a time is never a move on its own, but by the third step it has moved 9 px from where it rested.
    const settling = [1, 2, 3].map((i) =>
      g.update(SETTLE_MS + i * 250, [{ id: "a", rect: rect(i * 3, 0) }]).has("a"),
    );
    expect(settling).toEqual([false, false, true]);
  });

  it("the selector highlights a settling target but doesn't fill its dwell until it has settled", () => {
    const sel = new GazeSelector({
      ...APP_SELECTOR,
      dwell: { dwellMs: 600, stabilityPx: 60 },
      magnet: { snapPx: 6 },
    });
    const target = (settling: boolean): SelectorTarget[] => [{ id: "chip", rect: rect(100, 100), settling }];
    const events: string[] = [];
    let t = 0;
    for (; t < 1500; t += 33) {
      for (const e of sel.update({ t, x: 150, y: 130, confidence: 1 }, target(true))) events.push(e.type);
    }
    expect(sel.locked).toBe("chip");
    expect(events).not.toContain("selected");
    for (; t < 2500; t += 33) {
      for (const e of sel.update({ t, x: 150, y: 130, confidence: 1 }, target(false))) events.push(e.type);
    }
    expect(events).toContain("selected");
  });
});
