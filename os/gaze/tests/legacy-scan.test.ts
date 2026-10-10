import { describe, expect, it } from "vitest";
import { ScanEngine } from "../src/input/scan";

describe("switch scanning", () => {
  it("steps through items and selects the highlighted one", () => {
    const s = new ScanEngine({ intervalMs: 1000, firstItemExtraMs: 0, maxPasses: 3 });
    s.setItems(["a", "b", "c"], 0);
    expect(s.highlighted).toBe("a");
    s.tick(1000);
    expect(s.highlighted).toBe("b");
    expect(s.press(1200)).toEqual([{ type: "select", id: "b" }]);
    expect(s.highlighted).toBe("a");
  });

  it("pauses after several passes without a press, and a press restarts it", () => {
    const s = new ScanEngine({ intervalMs: 100, firstItemExtraMs: 0, maxPasses: 2 });
    s.setItems(["a", "b"], 0);
    for (let t = 100; t <= 1000; t += 100) s.tick(t);
    expect(s.isPaused).toBe(true);
    expect(s.highlighted).toBeNull();
    const ev = s.press(1100);
    expect(ev[0]).toEqual({ type: "highlight", id: "a" });
    expect(s.isPaused).toBe(false);
  });

  it("keeps the highlight when the item list refreshes", () => {
    const s = new ScanEngine({ intervalMs: 100, firstItemExtraMs: 0 });
    s.setItems(["a", "b", "c"], 0);
    s.tick(100);
    s.setItems(["x", "b", "c"], 150);
    expect(s.highlighted).toBe("b");
  });
});
