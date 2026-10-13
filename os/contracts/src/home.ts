/**
 * The home, by eye (added in v0, additive): lights, TV, fan, thermostat and blinds through Apple Shortcuts.
 *
 * A helper makes a shortcut in the Shortcuts app for each thing ("Bedroom light on"), then adds the device in
 * AGENCY with the shortcut's exact name for each action. Only the main process runs anything, and only shortcuts a
 * helper saved here: a window names a device and an action by id, never a shortcut. Main runs
 * `/usr/bin/shortcuts run` with an argument list (no shell), and any value for the shortcut goes in a file, never
 * in the command.
 *
 * Owner rule: no door locks, garage doors or gates, ever. `refusedHomeReason` turns those names away everywhere
 * (setup, main, the practice home). AGENCY can't see inside a shortcut, so this check is by name: the setup screen
 * tells helpers never to add a shortcut that opens or unlocks anything.
 */

export type HomeDeviceKind = "light" | "tv" | "fan" | "thermostat" | "blinds" | "other";

export const HOME_KINDS: readonly HomeDeviceKind[] = ["light", "tv", "fan", "thermostat", "blinds", "other"];

export interface HomeAction {
  /** Short id, unique within the device ("on", "off", "warmer"). */
  id: string;
  /** What the person sees: "On", "Warmer". */
  label: string;
  /** The exact name of the shortcut in the Shortcuts app. */
  shortcut: string;
  /** Optional fixed text handed to the shortcut as its input (for example "21" for a temperature). */
  input?: string;
  /** What to show as the device's state after this action worked ("On", "21°"). Defaults to the label. */
  state?: string;
  /** Ask for a confirmation look first. Some actions always ask (see `needsConfirmation`). */
  confirm?: boolean;
}

export interface HomeDevice {
  id: string;
  name: string;
  kind: HomeDeviceKind;
  actions: HomeAction[];
}

export interface HomeSetup {
  /** Off until a helper turns it on. While off nothing runs. */
  enabled: boolean;
  devices: HomeDevice[];
}

/** What AGENCY last asked a device to do. AGENCY can't read the device, so this is "last set", not a reading. */
export interface HomeState {
  state: string;
  at: number;
}

export interface HomeStatus {
  /** Shortcuts can run here (the Mac app on macOS). */
  available: boolean;
  /** Why not, in plain words, when `available` is false. */
  reason?: string;
  setup: HomeSetup;
  states: Record<string, HomeState>;
}

export type HomeRunResult = { ok: true; state: string } | { ok: false; error: string };

export type HomeSaveResult = { ok: true; status: HomeStatus } | { ok: false; error: string };

export type HomeShortcutsResult = { ok: true; names: string[] } | { ok: false; error: string };

/** `window.agency.home` (shell only). */
export interface HomeApi {
  status(): Promise<HomeStatus>;
  /** A helper's setup. Main checks it again with `checkHomeSetup`. */
  save(setup: HomeSetup): Promise<HomeSaveResult>;
  /** The names of the shortcuts on this Mac, for the setup screen to choose from. */
  shortcuts(): Promise<HomeShortcutsResult>;
  /** `confirmed` must be true for an action that needs a confirmation look. */
  run(deviceId: string, actionId: string, confirmed: boolean): Promise<HomeRunResult>;
}

export const HOME_LIMITS = {
  devices: 12,
  actions: 6,
  name: 40,
  label: 24,
  shortcut: 100,
  input: 100,
} as const;

const REFUSED = "AGENCY never controls locks, doors, garage doors or gates.";

/** Words split out of names like "FrontDoorUnlock" or "front_door-lock". */
function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * Plain words when a name looks like a lock, door, garage or gate, otherwise null. Errs on the side of refusing:
 * "Garage light" is refused too. Checks whole words and the unambiguous fragments inside run-together names.
 */
export function refusedHomeReason(...texts: (string | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    if (/unlock|deadbolt|garage|doorlock|lockdoor|frontdoor|backdoor/.test(lower)) return REFUSED;
    for (const w of words(text)) {
      if (/^(un)?lock(s|ed|ing)?$/.test(w)) return REFUSED;
      if (/^(door|doors|gate|gates|latch|latches|keypad)$/.test(w)) return REFUSED;
    }
  }
  return null;
}

const SAFETY = /\b(oven|stove|cooker|hob|heater|heating|heat|boiler|kettle|iron|space heater)\b/i;

/** A confirmation look before anything that could matter for safety: heating, ovens, anything a helper marked. */
export function needsConfirmation(device: HomeDevice, action: HomeAction): boolean {
  if (action.confirm) return true;
  if (device.kind === "thermostat") return true;
  return SAFETY.test(`${device.name} ${action.label} ${action.shortcut}`);
}

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function cleanLine(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t && t.length <= max ? t : null;
}

/**
 * Checks a setup from a window or a file. Returns a clean copy, or plain words about the first problem. A shortcut
 * name may not start with "-", so it can never be read as an option.
 */
export function checkHomeSetup(raw: unknown): { ok: true; setup: HomeSetup } | { ok: false; error: string } {
  const r = raw as Partial<HomeSetup> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.devices))
    return { ok: false, error: "That setup isn't valid." };
  if (r.devices.length > HOME_LIMITS.devices)
    return { ok: false, error: `At most ${HOME_LIMITS.devices} devices.` };
  const devices: HomeDevice[] = [];
  const ids = new Set<string>();
  for (const d of r.devices as Partial<HomeDevice>[]) {
    const name = cleanLine(d?.name, HOME_LIMITS.name);
    if (!d || typeof d.id !== "string" || !ID.test(d.id) || ids.has(d.id) || !name)
      return { ok: false, error: "Each device needs a short name." };
    if (!HOME_KINDS.includes(d.kind as HomeDeviceKind))
      return { ok: false, error: `${name}: choose what it is.` };
    const refused = refusedHomeReason(name);
    if (refused) return { ok: false, error: `${name}: ${refused}` };
    if (!Array.isArray(d.actions) || d.actions.length === 0 || d.actions.length > HOME_LIMITS.actions)
      return { ok: false, error: `${name}: add 1 to ${HOME_LIMITS.actions} actions.` };
    const actions: HomeAction[] = [];
    const actionIds = new Set<string>();
    for (const a of d.actions as Partial<HomeAction>[]) {
      const label = cleanLine(a?.label, HOME_LIMITS.label);
      const shortcut = cleanLine(a?.shortcut, HOME_LIMITS.shortcut);
      if (!a || typeof a.id !== "string" || !ID.test(a.id) || actionIds.has(a.id) || !label)
        return { ok: false, error: `${name}: each action needs a short label.` };
      if (!shortcut || shortcut.startsWith("-"))
        return { ok: false, error: `${name}, ${label}: type the shortcut's exact name.` };
      const blocked = refusedHomeReason(label, shortcut, a.input);
      if (blocked) return { ok: false, error: `${name}, ${label}: ${blocked}` };
      const action: HomeAction = { id: a.id, label, shortcut };
      if (a.input !== undefined && a.input !== "") {
        const input = cleanLine(a.input, HOME_LIMITS.input);
        if (!input) return { ok: false, error: `${name}, ${label}: the value is too long.` };
        action.input = input;
      }
      const state = cleanLine(a.state, HOME_LIMITS.label);
      if (state) action.state = state;
      if (a.confirm === true) action.confirm = true;
      actionIds.add(a.id);
      actions.push(action);
    }
    ids.add(d.id);
    devices.push({ id: d.id, name, kind: d.kind as HomeDeviceKind, actions });
  }
  return { ok: true, setup: { enabled: r.enabled === true, devices } };
}
