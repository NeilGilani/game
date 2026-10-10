/**
 * Mouse provider: the mouse (or trackpad) stands in for gaze, so everyone can build and test the
 * overlay, dwell and flows without a camera. Positions are global screen points.
 *
 * In the browser, attachTo(window) uses screenX/screenY of mouse events. In the Electron engine
 * window, the main process can poll screen.getCursorScreenPoint() and call push().
 */

import type { GazeProvider, ProviderFrame } from "./types";

export class MouseProvider implements GazeProvider {
  readonly id = "mouse";
  readonly kind = "pointer" as const;
  private onFrame: ((f: ProviderFrame) => void) | null = null;
  private detach: (() => void) | null = null;

  async start(onFrame: (f: ProviderFrame) => void): Promise<void> {
    this.onFrame = onFrame;
  }

  stop(): void {
    this.onFrame = null;
    this.detach?.();
    this.detach = null;
  }

  push(x: number, y: number, t: number = performance.now()): void {
    this.onFrame?.({ kind: "pointer", frame: { t, captureT: t, x, y, confidence: 1, source: "mouse" } });
  }

  /** Follow the mouse over a window (screenX/screenY are global points on macOS). */
  attachTo(target: Pick<Window, "addEventListener" | "removeEventListener">): void {
    this.detach?.();
    const handler = (e: Event) => {
      const m = e as MouseEvent;
      this.push(m.screenX, m.screenY, performance.now());
    };
    target.addEventListener("mousemove", handler);
    this.detach = () => target.removeEventListener("mousemove", handler);
  }
}
