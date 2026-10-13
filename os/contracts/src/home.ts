/**
 * The home, by eye: lights, TV, fan, thermostat and blinds through Apple Shortcuts that a caregiver set up and
 * named. Added in v0 (additive).
 *
 * Only the main process runs a shortcut (`/usr/bin/shortcuts run <name>`, an argument vector, never a shell). A
 * window can only name a device and one of its actions by id; main looks up the shortcut. Every run goes through
 * `prepare` (a ticket with a fingerprint) and `run` with the same fingerprint. Actions marked `confirm` (anything
 * that could matter for safety: heating, ovens) are shown on a confirmation screen first.
 *
 * Owner rule: no door locks, garage doors or gates, ever. Main refuses any device, action or shortcut whose name
 * mentions them, when it is saved and again before it runs.
 */

export type HomeDeviceKind = "light" | "tv" | "fan" | "thermostat" | "blinds" | "heater" | "plug" | "other";

export interface HomeActionDef {
  /** Unique within the device: lowercase letters, digits, "-" and "_". */
  id: string;
  /** What the person sees, e.g. "Turn on". */
  label: string;
  /** The exact name of the shortcut in the Shortcuts app. */
  shortcut: string;
  /** Fixed text passed to the shortcut as its input (e.g. "21" for a thermostat), or none. */
  input?: string;
  /** Needs a confirmation look before it runs. Always true for thermostats and heaters. */
  confirm: boolean;
}

export interface HomeDeviceDef {
  id: string;
  name: string;
  kind: HomeDeviceKind;
  actions: HomeActionDef[];
  /** A shortcut whose text output says the device's state ("On", "21°C"), or none. */
  statusShortcut?: string;
}

export interface HomeSettings {
  /** Off until a helper turns it on in Settings. */
  enabled: boolean;
  devices: HomeDeviceDef[];
}

export interface HomeDeviceView {
  id: string;
  name: string;
  kind: HomeDeviceKind;
  actions: { id: string; label: string; confirm: boolean }[];
  /** What AGENCY knows about the state, in plain words, or null when it knows nothing. */
  state: string | null;
  /** True when the state came from the device's status shortcut; false when it is only the last action AGENCY ran. */
  stateFromDevice: boolean;
  /** When the state was learned (ms since the epoch), or null. */
  stateAt: number | null;
}

export interface HomeStatus {
  /** Shortcuts can run here (the Mac app on macOS 12+). */
  available: boolean;
  reason?: string;
  enabled: boolean;
  /** Empty while turned off. */
  devices: HomeDeviceView[];
}

export type HomePrepareResult =
  | {
      ok: true;
      ticket: string;
      fingerprint: string;
      device: string;
      action: string;
      confirm: boolean;
      /** Exactly what will happen, for the screen: "Turn on: Bedroom lamp". */
      summary: string;
    }
  | { ok: false; error: string };

export type HomeRunResult = { ok: true; state: string | null; summary: string } | { ok: false; error: string };

export type HomeSaveResult = { ok: true; settings: HomeSettings } | { ok: false; error: string };

export type HomeShortcutsResult = { ok: true; names: string[] } | { ok: false; error: string };

/** `window.agency.home` (shell only). */
export interface HomeApi {
  status(): Promise<HomeStatus>;
  /** Run every status shortcut and return the new states. */
  refresh(): Promise<HomeStatus>;
  settings(): Promise<HomeSettings>;
  setSettings(settings: HomeSettings): Promise<HomeSaveResult>;
  /** The names of the shortcuts on this Mac, for a helper choosing them in Settings. */
  shortcuts(): Promise<HomeShortcutsResult>;
  prepare(deviceId: string, actionId: string): Promise<HomePrepareResult>;
  run(ticket: string, fingerprint: string): Promise<HomeRunResult>;
  /** Forget a ticket that wasn't confirmed. */
  cancel(ticket: string): Promise<void>;
}
