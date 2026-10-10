import { describe, expect, it } from "vitest";
import { distanceToRect, gapBetween, pickTarget, readingOrder, targetsNear } from "../src/core/geometry";
import { axTarget } from "./helpers";

describe("geometry", () => {
  it("measures distance to a rect (0 inside)", () => {
    const r = { x: 10, y: 10, width: 10, height: 10 };
    expect(distanceToRect({ x: 15, y: 15 }, r)).toBe(0);
    expect(distanceToRect({ x: 0, y: 15 }, r)).toBe(10);
    expect(distanceToRect({ x: 23, y: 24 }, r)).toBe(5);
  });

  it("picks the smallest containing target, else the nearest within snap", () => {
    const cell = axTarget("cell", 0, 0, 400, 100);
    const button = axTarget("button", 10, 10, 80, 30);
    expect(pickTarget({ x: 20, y: 20 }, [cell, button], 30)?.id).toBe("button");
    expect(pickTarget({ x: 450, y: 50 }, [cell], 30)).toBeNull();
    expect(pickTarget({ x: 420, y: 50 }, [cell], 30)?.id).toBe("cell");
  });

  it("lists targets near a point, nearest first", () => {
    const a = axTarget("a", 0, 0, 20, 20);
    const b = axTarget("b", 50, 0, 20, 20);
    expect(targetsNear({ x: 45, y: 10 }, [a, b], 30).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("orders in reading order by rows", () => {
    const items = [axTarget("c", 0, 100, 10, 10), axTarget("b", 200, 2, 10, 10), axTarget("a", 0, 0, 10, 10)];
    expect(readingOrder(items).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("measures the gap between rects", () => {
    expect(gapBetween({ x: 0, y: 0, width: 10, height: 10 }, { x: 34, y: 0, width: 10, height: 10 })).toBe(
      24,
    );
  });
});
