/**
 * The home's devices, saved by a helper in <userData>/home.json, and the checks every one passes before it is saved
 * and again before anything runs.
 *
 * Owner rule: no door locks, garage doors or gates, ever. A name that mentions them is refused wherever it appears
 * (device, action, shortcut, input). AGENCY can't look inside a shortcut, so the setup screen also tells the helper
 * never to name a shortcut here that opens the home.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HomeActionDef, HomeDeviceDef, HomeDeviceKind, HomeSettings } from "@agency/contracts";

export const MAX_DEVICES = 12;
export const MAX_ACTIONS = 6;
const KINDS: readonly HomeDeviceKind[] = [
  "light",
  "tv",
  "fan",
  "thermostat",
  "blinds",
  "heater",
  "plug",
  "other",
];
/** Kinds where every action needs a confirmation look: getting them wrong could matter for safety. */
export const SAFETY_KINDS: readonly HomeDeviceKind[] = ["thermostat", "heater"];
const ID = /^[a-z0-9_-]{1,40}$/;

/** Words that mean a lock, door, garage or gate. Matched as whole words, so "clock" and "indoor" are fine. */
export const FORBIDDEN =
  /\b(un)?lock(s|ed|ing)?\b|\bdeadbolts?\b|\bdoors?\b|\bdoorway\b|\bgarages?\b|\bgates?\b|\bkeypad\b|\bentry\b|\bsecurity system\b|\balarm system\b|\bdisarm\b/i;

export const FORBIDDEN_MESSAGE =
  'AGENCY never controls doors, locks, garage doors or gates, so nothing can open the home by accident. Rename it (for example "Porch light") or leave it out.';

export const DEFAULT_HOME: HomeSettings = { enabled: false, devices: [] };

export class HomeConfigError extends Error {}

/** One line of plain text, at most `max` characters. */
function text(v: unknown, max: number, what: string): string {
  if (typeof v !== "string") throw new HomeConfigError(`${what} is missing.`);
  const t = v
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) throw new HomeConfigError(`${what} is missing.`);
  if (t.length > max) throw new HomeConfigError(`${what} is longer than ${max} characters.`);
  return t;
}

function allowed(value: string, what: string): string {
  if (FORBIDDEN.test(value)) throw new HomeConfigError(`${what} "${value}": ${FORBIDDEN_MESSAGE}`);
  return value;
}

/** A shortcut name as the Shortcuts app shows it. No line breaks, and nothing that looks like an option. */
export function shortcutName(v: unknown, what: string): string {
  const name = text(v, 100, what);
  if (name.startsWith("-")) throw new HomeConfigError(`${what} can't start with "-".`);
  return allowed(name, what);
}

function action(raw: unknown, kind: HomeDeviceKind, device: string): HomeActionDef {
  const a = (raw ?? {}) as Partial<HomeActionDef>;
  const id = typeof a.id === "string" && ID.test(a.id) ? a.id : null;
  if (!id) throw new HomeConfigError(`${device}: every action needs an id (letters, digits, - or _).`);
  const label = allowed(text(a.label, 30, `${device}: an action's name`), `${device}: action`);
  const out: HomeActionDef = {
    id,
    label,
    shortcut: shortcutName(a.shortcut, `${device}, ${label}: the shortcut`),
    confirm: SAFETY_KINDS.includes(kind) || a.confirm === true,
  };
  if (a.input !== undefined && a.input !== "")
    out.input = allowed(text(a.input, 60, `${device}, ${label}: the input`), `${device}, ${label}: input`);
  return out;
}

function device(raw: unknown): HomeDeviceDef {
  const d = (raw ?? {}) as Partial<HomeDeviceDef>;
  const name = allowed(text(d.name, 40, "A device's name"), "Device");
  const id = typeof d.id === "string" && ID.test(d.id) ? d.id : null;
  if (!id) throw new HomeConfigError(`${name}: the id must be letters, digits, - or _.`);
  const kind = KINDS.includes(d.kind as HomeDeviceKind) ? (d.kind as HomeDeviceKind) : null;
  if (!kind) throw new HomeConfigError(`${name}: choose what kind of device it is.`);
  if (!Array.isArray(d.actions) || d.actions.length === 0)
    throw new HomeConfigError(`${name}: add at least one action, like "Turn on".`);
  if (d.actions.length > MAX_ACTIONS) throw new HomeConfigError(`${name}: at most ${MAX_ACTIONS} actions.`);
  const actions = d.actions.map((a) => action(a, kind, name));
  if (new Set(actions.map((a) => a.id)).size !== actions.length)
    throw new HomeConfigError(`${name}: two actions have the same id.`);
  const out: HomeDeviceDef = { id, name, kind, actions };
  if (d.statusShortcut) out.statusShortcut = shortcutName(d.statusShortcut, `${name}: the status shortcut`);
  return out;
}

/** The settings as they may be saved, or a HomeConfigError saying in plain words what to fix. */
export function validateHome(raw: unknown): HomeSettings {
  const s = (raw ?? {}) as Partial<HomeSettings>;
  if (!Array.isArray(s.devices)) throw new HomeConfigError("The list of devices is missing.");
  if (s.devices.length > MAX_DEVICES) throw new HomeConfigError(`At most ${MAX_DEVICES} devices.`);
  const devices = s.devices.map(device);
  if (new Set(devices.map((d) => d.id)).size !== devices.length)
    throw new HomeConfigError("Two devices have the same id.");
  // Only an explicit true turns it on.
  return { enabled: s.enabled === true, devices };
}

/** Saved settings, or the defaults (off, no devices) when the file is missing or no longer passes the checks. */
export function loadHome(file: string): HomeSettings {
  if (!existsSync(file)) return structuredClone(DEFAULT_HOME);
  try {
    return validateHome(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return structuredClone(DEFAULT_HOME);
  }
}

export function saveHome(file: string, settings: HomeSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
