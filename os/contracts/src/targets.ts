/** Things the gaze can select, from any source, in global screen points. */

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TargetSource = "shell" | "overlay" | "ax" | "web";

export interface Target {
  /** Stable for the life of the element where possible (AX element hash, web element ref). */
  id: string;
  rect: ScreenRect;
  /** Accessibility role, e.g. "button", "link", "textfield", "checkbox", "menuitem", "tab". */
  role: string;
  /** Accessible name shown in pickers and read aloud. */
  label: string;
  source: TargetSource;
  /** App bundle id (ax) or tab origin (web). */
  owner?: string;
  /** Multiplies the dwell time (e.g. 2 for Cancel in an emergency). */
  dwellScale?: number;
  /** Protected targets (Help, Stop, Resume) stay selectable when eye control is paused. */
  protected?: boolean;
  /** Text fields: true for password fields. Never show, log or type into these automatically. */
  secure?: boolean;
}

export interface TargetSnapshot {
  t: number;
  /** Frontmost app bundle id, or tab origin for web. */
  owner: string | null;
  targets: Target[];
  /** True when the source returned fewer elements than exist (performance cap). */
  truncated: boolean;
}
