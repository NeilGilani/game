import { describe, expect, it } from "vitest";
import type { Target } from "../src/contracts";
import {
  decidePrecision,
  magnifiedTargets,
  magnifiedToScreen,
  pickerLabels,
  screenToMagnified,
} from "../src/precision";

const display = { x: 0, y: 0, width: 1470, height: 956 };
const t = (id: string, x: number, y: number, w = 30, h = 20, label = id): Target => ({
  id,
  rect: { x, y, width: w, height: h },
  role: "button",
  label,
  source: "ax",
});

describe("precision helpers", () => {
  it("goes direct when nothing or one thing is near", () => {
    expect(decidePrecision({ x: 100, y: 100 }, 50, [t("far", 800, 800)], [display])).toEqual({
      kind: "direct",
      targetId: null,
    });
    expect(decidePrecision({ x: 100, y: 100 }, 50, [t("a", 90, 90)], [display])).toEqual({
      kind: "direct",
      targetId: "a",
    });
  });

  it("goes direct for a big target that contains the whole error circle", () => {
    const big = t("big", 0, 0, 600, 400);
    const d = decidePrecision({ x: 300, y: 200 }, 80, [big, t("other", 610, 200)], [display]);
    expect(d).toEqual({ kind: "direct", targetId: "big" });
  });

  it("offers a picker of big labelled buttons for a few close targets", () => {
    const targets = [t("Save", 500, 400), t("Cancel", 540, 400), t("Help", 580, 400)];
    const d = decidePrecision({ x: 545, y: 410 }, 80, targets, [display]);
    expect(d.kind).toBe("picker");
    if (d.kind !== "picker") return;
    expect(d.buttons.map((b) => b.label)).toEqual(["Cancel", "Save", "Help", "None of these"]);
    for (const b of d.buttons) {
      expect(b.rect.width).toBeGreaterThanOrEqual(96);
      expect(b.rect.height).toBeGreaterThanOrEqual(96);
      expect(b.rect.x).toBeGreaterThanOrEqual(0);
      expect(b.rect.x + b.rect.width).toBeLessThanOrEqual(display.width);
    }
    // At least 24 points between buttons.
    for (const a of d.buttons)
      for (const b of d.buttons) {
        if (a === b) continue;
        const gapX = Math.max(b.rect.x - (a.rect.x + a.rect.width), a.rect.x - (b.rect.x + b.rect.width));
        const gapY = Math.max(b.rect.y - (a.rect.y + a.rect.height), a.rect.y - (b.rect.y + b.rect.height));
        expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(24);
      }
  });

  it("names duplicates by where they are", () => {
    const labels = pickerLabels([
      t("a", 100, 100, 30, 20, "Delete"),
      t("b", 300, 100, 30, 20, "Delete"),
      t("c", 200, 100, 30, 20, "Edit"),
    ]);
    expect(labels).toEqual(["Delete, on the left", "Delete, on the right", "Edit"]);
  });

  it("magnifies 2 to 4 times when there are too many or unnamed targets", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      t(`k${i}`, 600 + (i % 5) * 22, 400 + Math.floor(i / 5) * 22, 18, 18),
    );
    const d = decidePrecision({ x: 650, y: 420 }, 90, many, [display]);
    expect(d.kind).toBe("magnify");
    if (d.kind !== "magnify") return;
    expect(d.zoom).toBeGreaterThanOrEqual(2);
    expect(d.zoom).toBeLessThanOrEqual(4);
    const unnamed = decidePrecision(
      { x: 650, y: 420 },
      90,
      [t("x", 640, 410, 18, 18, ""), t("y", 664, 410, 18, 18, "")],
      [display],
    );
    expect(unnamed.kind).toBe("magnify");
  });

  it("maps a dwell on the lens back to the real screen point", () => {
    const m = {
      region: { x: 600, y: 400, width: 200, height: 200 },
      lens: { x: 300, y: 100, width: 800, height: 800 },
    };
    const s = screenToMagnified(m, 650, 420);
    expect(magnifiedToScreen(m, s.x, s.y)).toEqual({ x: 650, y: 420 });
    const [mt] = magnifiedTargets(m, [t("k", 620, 410, 20, 20)]);
    expect(mt!.rect.width).toBeCloseTo(80, 6);
  });

  it("keeps the lens on the display near an edge", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      t(`e${i}`, 1440 - (i % 3) * 20, 930 - Math.floor(i / 3) * 20, 16, 16),
    );
    const d = decidePrecision({ x: 1460, y: 945 }, 80, many, [display]);
    if (d.kind !== "magnify") throw new Error("expected magnify");
    expect(d.lens.x + d.lens.width).toBeLessThanOrEqual(display.width + 1e-9);
    expect(d.lens.y + d.lens.height).toBeLessThanOrEqual(display.height + 1e-9);
  });
});
