/**
 * The real host: Instance 1's preload API (`window.agency`) inside the Electron overlay window.
 *
 * The preload shape below is what the overlay expects; it is a request to Instance 1, not yet a
 * contract (see INTEGRATION_REQUEST.md). Channel names come from os/contracts/src/ipc.ts.
 */

import { IPC, type GazeEvent, type ScreenRect, type TargetSnapshot } from "../contracts";
import type { OverlayFeed, OverlayHost } from "./host";

export interface AgencyPreload {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  /** Global bounds of the display this window covers. */
  display(): ScreenRect;
}

declare global {
  interface Window {
    agency?: AgencyPreload;
  }
}

export function agencyHost(agency: AgencyPreload): OverlayHost & OverlayFeed {
  return {
    display: agency.display(),
    native: (method, params) => agency.invoke(IPC.native, { method, params }) as never,
    lifeline: (signal) => agency.send(IPC.lifeline, signal),
    stopAll: () => agency.send(IPC.stopAll, {}),
    home: () => agency.send(IPC.overlay, { type: "home" }),
    memorySuggestions: (surface, limit) =>
      agency.invoke(IPC.overlay, { type: "memory.suggestions", surface, limit }) as never,
    logSelection: (event) => agency.send(IPC.overlay, { type: "memory.event", event }),
    setInteractiveRegions: (rects) => agency.send(IPC.overlay, { type: "interactive-regions", rects }),
    onGaze: (cb) => agency.on(IPC.gaze, (p) => cb(p as GazeEvent)),
    onTargets: (cb) => agency.on(IPC.targets, (p) => cb(p as TargetSnapshot)),
  };
}
