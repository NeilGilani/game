import { describe, expect, it } from "vitest";
import { decidePrecision, errorRadiusFor } from "../src/core/precision";
import { axTarget } from "./helpers";

describe("precision: which one?", () => {
  it("snaps directly when one target is near", () => {
    const d = decidePrecision({ x: 100, y: 100 }, [axTarget("ok", 80, 90, 60, 20)]);
    expect(d).toMatchObject({ kind: "direct", target: { id: "ok" } });
  });

  it("returns nothing when nothing is near", () => {
    expect(decidePrecision({ x: 900, y: 900 }, [axTarget("a", 0, 0, 20, 20)])).toEqual({
      kind: "direct",
      target: null,
    });
  });

  it("asks which one when small targets crowd the error circle", () => {
    const targets = [
      axTarget("a", 90, 90, 16, 16),
      axTarget("b", 112, 90, 16, 16),
      axTarget("c", 134, 90, 16, 16),
    ];
    const d = decidePrecision({ x: 115, y: 98 }, targets);
    expect(d.kind).toBe("pick");
    if (d.kind === "pick") expect(d.candidates.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not ask when the gaze is well inside a big target", () => {
    const big = axTarget("big", 0, 0, 300, 200);
    const far = axTarget("far", 0, 260, 50, 20);
    expect(decidePrecision({ x: 150, y: 100 }, [big, far])).toMatchObject({
      kind: "direct",
      target: { id: "big" },
    });
  });

  it("switches to the magnifier when too many candidates", () => {
    const targets = Array.from({ length: 10 }, (_, i) =>
      axTarget(`t${i}`, 100 + (i % 5) * 18, 100 + Math.floor(i / 5) * 18, 14, 14),
    );
    const d = decidePrecision({ x: 140, y: 110 }, targets);
    expect(d.kind).toBe("magnify");
    if (d.kind === "magnify") {
      expect(d.zoom).toBeGreaterThanOrEqual(2);
      expect(d.zoom).toBeLessThanOrEqual(4);
    }
  });

  it("derives a generous error radius from calibration", () => {
    expect(errorRadiusFor(null)).toBe(60);
    expect(errorRadiusFor(10)).toBe(30);
    expect(errorRadiusFor(80)).toBe(120);
  });
});
