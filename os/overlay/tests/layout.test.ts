import { describe, expect, it } from "vitest";
import type { ScreenRect } from "../src/contracts";
import { GAP, MIN_TARGET, gapBetween, layoutRail, overlapArea, paginate, placePanel } from "./reexports";
import { layoutKeyboard } from "../src/keyboard/layout";

const display: ScreenRect = { x: 0, y: 0, width: 1470, height: 956 };

function checkSpacing(rects: ScreenRect[]) {
  for (const r of rects) {
    expect(r.width).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(r.height).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      expect(gapBetween(rects[i]!, rects[j]!)).toBeGreaterThanOrEqual(GAP - 0.001);
    }
}

describe("layout", () => {
  it("rail buttons are big, spaced and inside the display", () => {
    for (const side of ["left", "right"] as const) {
      const rail = layoutRail(display, side, 6);
      checkSpacing(rail);
      for (const r of rail) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(display.width);
        expect(r.y + r.height).toBeLessThanOrEqual(display.height);
      }
    }
  });

  it("places panels away from what the person is looking at", () => {
    const area = { x: 16, y: 16, width: 1300, height: 924 };
    const lookingAtBottom = { x: 500, y: 800, width: 300, height: 60 };
    const p = placePanel(area, { width: 800, height: 400 }, [lookingAtBottom]);
    expect(overlapArea(p, lookingAtBottom)).toBe(0);
    const lookingAtTop = { x: 500, y: 40, width: 300, height: 60 };
    const q = placePanel(area, { width: 800, height: 400 }, [lookingAtTop]);
    expect(overlapArea(q, lookingAtTop)).toBe(0);
  });

  it("pages lists instead of scrolling", () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    expect(paginate(items, 6, 0)).toMatchObject({ items: [0, 1, 2, 3, 4, 5], pages: 3 });
    expect(paginate(items, 6, 9)).toMatchObject({ items: [12], page: 2 });
  });

  it("keyboard keys are at least 96 pt with 24 pt gaps on a 13-inch MacBook", () => {
    for (const page of ["letters", "symbols"] as const) {
      const k = layoutKeyboard(page, 1300);
      expect(k.columns).toBe(10);
      checkSpacing(k.keys.map((x) => x.rect));
      expect(k.size.width).toBeLessThanOrEqual(1300);
    }
  });

  it("falls back to fewer columns on a narrow display instead of shrinking keys", () => {
    const k = layoutKeyboard("letters", 1100);
    expect(k.columns).toBeLessThan(10);
    checkSpacing(k.keys.map((x) => x.rect));
    expect(k.size.width).toBeLessThanOrEqual(1100);
    const letters = k.keys.filter((x) => x.action.kind === "char").map((x) => x.label);
    for (const c of "abcdefghijklmnopqrstuvwxyz") expect(letters).toContain(c);
  });
});

describe("keyboard sizing", () => {
  it("keeps QWERTY at 96 pt rather than switching layout for bigger keys", () => {
    const k = layoutKeyboard("letters", 1254);
    expect(k.columns).toBe(10);
    expect(k.keySize).toBeGreaterThanOrEqual(96);
  });
});
