/**
 * Global screen space across displays. Coordinates are macOS points with the origin at the
 * top-left of the main display (the contract's convention); other displays can sit at negative
 * coordinates. The host (Electron's screen module, or agency-native) supplies the displays.
 */

import type { ScreenRect } from "./contracts";

export interface DisplayInfo {
  id: string;
  /** Global screen points. */
  bounds: ScreenRect;
  /** Backing pixels per point (2 on Retina). */
  scaleFactor: number;
  primary: boolean;
  /** True for the display the webcam is attached to (usually the built-in one). */
  hasCamera: boolean;
}

export class ScreenSpace {
  constructor(readonly displays: readonly DisplayInfo[]) {
    if (displays.length === 0) throw new Error("at least one display is needed");
  }

  /** The display gaze is calibrated on: the camera's display, else the primary. */
  get cameraDisplay(): DisplayInfo {
    return (
      this.displays.find((d) => d.hasCamera) ?? this.displays.find((d) => d.primary) ?? this.displays[0]!
    );
  }

  displayAt(x: number, y: number): DisplayInfo | null {
    return (
      this.displays.find(
        (d) =>
          x >= d.bounds.x &&
          x < d.bounds.x + d.bounds.width &&
          y >= d.bounds.y &&
          y < d.bounds.y + d.bounds.height,
      ) ?? null
    );
  }

  /** The nearest point that is on some display (gaze estimates can land off every screen). */
  clamp(x: number, y: number): { x: number; y: number; display: DisplayInfo } {
    let best: { x: number; y: number; display: DisplayInfo; d: number } | null = null;
    for (const display of this.displays) {
      const b = display.bounds;
      const cx = Math.max(b.x, Math.min(b.x + b.width - 1, x));
      const cy = Math.max(b.y, Math.min(b.y + b.height - 1, y));
      const d = Math.hypot(cx - x, cy - y);
      if (!best || d < best.d) best = { x: cx, y: cy, display, d };
    }
    return { x: best!.x, y: best!.y, display: best!.display };
  }

  /** How far (points) a point is outside the calibrated display; 0 inside it. */
  outsideCalibrated(x: number, y: number): number {
    const b = this.cameraDisplay.bounds;
    const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
    const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
    return Math.hypot(dx, dy);
  }
}

/** One display filling the given size, for the web app and tests. */
export function singleDisplay(width: number, height: number, scaleFactor = 2): ScreenSpace {
  return new ScreenSpace([
    { id: "main", bounds: { x: 0, y: 0, width, height }, scaleFactor, primary: true, hasCamera: true },
  ]);
}

export interface WindowGeometry {
  /** window.screenX / screenY: the window's top-left in global points. */
  screenX: number;
  screenY: number;
  /** Height of browser chrome above the page (outerHeight - innerHeight for a normal window). */
  chromeTop: number;
  /** Horizontal border on the left (usually 0 on macOS). */
  chromeLeft: number;
  /** Page zoom (devicePixelRatio / display scale); 1 at 100 %. */
  zoom: number;
}

export function viewportToGlobal(w: WindowGeometry, x: number, y: number): { x: number; y: number } {
  return { x: w.screenX + w.chromeLeft + x * w.zoom, y: w.screenY + w.chromeTop + y * w.zoom };
}

export function globalToViewport(w: WindowGeometry, x: number, y: number): { x: number; y: number } {
  return { x: (x - w.screenX - w.chromeLeft) / w.zoom, y: (y - w.screenY - w.chromeTop) / w.zoom };
}
