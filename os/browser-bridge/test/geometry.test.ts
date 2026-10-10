import { describe, expect, it } from "vitest";
import { contentOrigin, toScreenRect } from "../src/geometry.ts";

const win = { left: 100, top: 80, width: 1200, height: 900 };
const vp = (iw: number, ih: number, extra = {}) => ({ innerWidth: iw, innerHeight: ih, vvOffsetLeft: 0, vvOffsetTop: 0, vvScale: 1, ...extra });

describe("screen geometry", () => {
  it("puts the content area under the toolbar", () => {
    const o = contentOrigin(win, vp(1200, 813), 1);
    expect(o).toMatchObject({ x: 100, y: 167, scale: 1 });
    expect(toScreenRect({ x: 400, y: 160, width: 200, height: 120 }, o, vp(1200, 813))).toEqual({ x: 500, y: 327, width: 200, height: 120 });
  });

  it("scales CSS pixels by page zoom (matches Chrome at 150%)", () => {
    const v = vp(800, 542);
    const o = contentOrigin(win, v, 1.5);
    expect(o.y).toBe(167);
    const r = toScreenRect({ x: 400, y: 160, width: 200, height: 120 }, o, v)!;
    expect(r).toEqual({ x: 700, y: 407, width: 300, height: 180 });
  });

  it("clips to the visible content area and drops what is off screen", () => {
    const v = vp(1200, 813);
    const o = contentOrigin(win, v, 1);
    expect(toScreenRect({ x: 1150, y: 10, width: 200, height: 50 }, o, v)).toEqual({ x: 1250, y: 177, width: 50, height: 50 });
    expect(toScreenRect({ x: 10, y: -500, width: 100, height: 100 }, o, v)).toBeNull();
    expect(toScreenRect({ x: 10, y: 900, width: 100, height: 100 }, o, v)).toBeNull();
  });

  it("accounts for pinch zoom", () => {
    const v = vp(1200, 813, { vvOffsetLeft: 100, vvOffsetTop: 50, vvScale: 2 });
    const o = contentOrigin(win, v, 1);
    expect(toScreenRect({ x: 150, y: 100, width: 10, height: 10 }, o, v)).toEqual({ x: 200, y: 267, width: 20, height: 20 });
  });
});
