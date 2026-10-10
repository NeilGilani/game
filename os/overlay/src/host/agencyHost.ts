/**
 * The real host: Instance 1's typed preload API (`window.agency`, `AgencyApi` in os/contracts/src/host.ts)
 * inside the Electron overlay window. Main checks every native call against NATIVE_ALLOWED.overlay.
 */

import type { AgencyApi, OverlayMode, ScreenRect, StopAllResult } from "../contracts";
import type { OverlayFeed, OverlayHost } from "./host";

declare global {
  interface Window {
    agency?: AgencyApi;
  }
}

/** Display bounds from the overlay window's query string (`?display=&x=&y=&w=&h=&scale=`), set by main. */
export function displayFromQuery(search: string, fallback: ScreenRect): ScreenRect {
  const q = new URLSearchParams(search);
  const n = (k: string) => {
    const v = q.get(k);
    return v === null || v.trim() === "" ? NaN : Number(v);
  };
  const r = { x: n("x"), y: n("y"), width: n("w"), height: n("h") };
  return Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0 ? r : fallback;
}

export interface AgencyHostExtras {
  /** Stop was used somewhere else (another window, the hotkey, the agent). */
  onStopAll(cb: (result: StopAllResult) => void): () => void;
  /** Main asks the overlay to change mode (keyboard, numbers, paused...). */
  onMode(cb: (mode: OverlayMode) => void): () => void;
}

export function agencyHost(
  agency: AgencyApi,
  display: ScreenRect,
): OverlayHost & OverlayFeed & AgencyHostExtras {
  return {
    display,
    native: (method, params) => agency.native.call(method, params),
    lifeline: (signal) => {
      // Help goes straight to main, which also brings the shell's help screen to the front itself.
      if (signal.type === "lifeline.help") void agency.lifeline.help(signal.source, signal.test);
      else if (signal.type !== "lifeline.surface") agency.lifeline.signal(signal);
    },
    stopAll: () => void agency.stopAll(),
    home: () => agency.showHome(),
    memorySuggestions: (surface, limit) => agency.memory.suggestions(surface, limit),
    logSelection: (event) => void agency.memory.event(event),
    setInteractiveRegions: (rects) => agency.overlay.setInteractiveRegions(rects),
    onGaze: (cb) => agency.gaze.onEvent(cb),
    onTargets: (cb) => agency.targets.onSnapshot(cb),
    onStopAll: (cb) => agency.onStopAll(cb),
    onMode: (cb) => agency.overlay.onMode(cb),
  };
}
