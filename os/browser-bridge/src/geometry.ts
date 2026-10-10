/**
 * Turning rectangles in a web page into global macOS screen points for the eye-control overlay.
 *
 * Inputs come from two places:
 *  - the service worker: the window's bounds in screen points (chrome.windows, DIP = macOS points) and the
 *    tab's zoom factor (chrome.tabs.getZoom);
 *  - the content script: the viewport size in CSS pixels, pinch-zoom (visualViewport) and element rects
 *    from getBoundingClientRect (CSS pixels, relative to the layout viewport).
 *
 * The page's content area sits at the bottom of the window (tabs and toolbar above it, nothing below in
 * current Chrome on macOS), flush with the window's left edge unless a side panel is open on the left.
 * Device pixel ratio cancels out: screen points are DIPs, and CSS px * zoom = DIPs.
 */

import type { ScreenRect } from "../../contracts/src/index.ts";
import type { ViewportRect } from "./protocol.ts";

export interface WindowGeometry {
  /** chrome.windows.Window left/top/width/height, in screen points. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportGeometry {
  /** window.innerWidth / innerHeight, CSS px (includes classic scrollbars). */
  innerWidth: number;
  innerHeight: number;
  /** window.visualViewport offset and scale (pinch zoom); 0, 0, 1 when not pinch-zoomed. */
  vvOffsetLeft: number;
  vvOffsetTop: number;
  vvScale: number;
  /** Where the content area starts inside the window, if the content script measured it (CSS px). */
  sidePanelLeft?: number;
}

export interface ContentOrigin {
  x: number;
  y: number;
  /** Screen points per CSS pixel. */
  scale: number;
  /** The content area in screen points, for clipping. */
  clip: ScreenRect;
}

export function contentOrigin(win: WindowGeometry, vp: ViewportGeometry, zoom: number): ContentOrigin {
  const z = zoom > 0 ? zoom : 1;
  const viewW = vp.innerWidth * z;
  const viewH = vp.innerHeight * z;
  const left = win.left + (vp.sidePanelLeft ?? 0) * z;
  const top = win.top + Math.max(0, win.height - viewH);
  return { x: left, y: top, scale: z, clip: { x: left, y: top, width: viewW, height: viewH } };
}

/** A viewport rect (CSS px from getBoundingClientRect) in global screen points, clipped to the content area. */
export function toScreenRect(
  r: ViewportRect,
  origin: ContentOrigin,
  vp: ViewportGeometry,
): ScreenRect | null {
  const s = vp.vvScale > 0 ? vp.vvScale : 1;
  // Pinch zoom magnifies the layout viewport around the visual viewport's offset.
  const vx = (r.x - vp.vvOffsetLeft) * s;
  const vy = (r.y - vp.vvOffsetTop) * s;
  const x0 = origin.x + vx * origin.scale;
  const y0 = origin.y + vy * origin.scale;
  const x1 = x0 + r.width * s * origin.scale;
  const y1 = y0 + r.height * s * origin.scale;
  const c = origin.clip;
  const cx0 = Math.max(x0, c.x);
  const cy0 = Math.max(y0, c.y);
  const cx1 = Math.min(x1, c.x + c.width);
  const cy1 = Math.min(y1, c.y + c.height);
  if (cx1 - cx0 < 1 || cy1 - cy0 < 1) return null;
  return { x: round2(cx0), y: round2(cy0), width: round2(cx1 - cx0), height: round2(cy1 - cy0) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
