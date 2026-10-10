/**
 * What the overlay needs from the window it runs in. Instance 1's preload (`window.agency`) provides the
 * real one (see agencyHost.ts and INTEGRATION_REQUEST.md); fakeHost.ts provides one for the browser,
 * Vitest and Playwright.
 */

import type {
  GazeEvent,
  LifelineSignal,
  NativeMethod,
  NativeMethods,
  ScreenRect,
  SelectionEvent,
  Suggestion,
  Surface,
  TargetSnapshot,
} from "../contracts";

export type NativeCall = <M extends NativeMethod>(
  method: M,
  params: NativeMethods[M]["params"],
) => Promise<NativeMethods[M]["result"]>;

export interface OverlayHost {
  /** agency-native through the main process (IPC.native). Only the preload's allowed subset. */
  native: NativeCall;
  /** IPC.lifeline. Must never be blocked or delayed. */
  lifeline(signal: LifelineSignal): void;
  /** IPC.stopAll: stop the agent and all synthetic input at once. */
  stopAll(): void;
  /** Bring the shell's Home to the front. */
  home(): void;
  /** AGENCY Bridge press of a web target (Instance 5), when available. */
  pressWeb?(targetId: string): Promise<{ ok: boolean; error?: string }>;
  /** Memory tree (Instance 6), through the main process or coordinator. */
  memorySuggestions?(surface: Surface, limit: number): Promise<Suggestion[]>;
  logSelection?(event: SelectionEvent): void;
  /** The overlay's own clickable rects, so the window is click-through everywhere else. */
  setInteractiveRegions?(rects: ScreenRect[]): void;
}

/** Event sources the window feeds into the controller. */
export interface OverlayFeed {
  /** Global bounds of the display this overlay window covers. */
  display: ScreenRect;
  onGaze(cb: (e: GazeEvent) => void): () => void;
  onTargets(cb: (s: TargetSnapshot) => void): () => void;
}
