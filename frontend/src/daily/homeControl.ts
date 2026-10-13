/**
 * The home, by eye: the Mac app's named Apple Shortcuts (window.agency.home, os/desktop/src/main/home), or a
 * practice home in the browser, the web demo and tests. The practice home changes nothing real and says so.
 *
 * Both follow the same rules (os/contracts/src/home.ts): never locks, doors, garage doors or gates, and a
 * confirmation look for heating, ovens and anything a helper marked.
 */
import {
  checkHomeSetup,
  needsConfirmation,
  refusedHomeReason,
  type HomeApi,
  type HomeDevice,
  type HomeDeviceKind,
  type HomeRunResult,
  type HomeSaveResult,
  type HomeSetup,
  type HomeShortcutsResult,
  type HomeState,
  type HomeStatus,
} from "../../../os/contracts/src/home";
import { fakeForced, host } from "../state/host";
import { webDemo } from "./store";

export type {
  HomeAction,
  HomeDevice,
  HomeDeviceKind,
  HomeSetup,
  HomeStatus,
} from "../../../os/contracts/src/home";
export {
  HOME_KINDS,
  HOME_LIMITS,
  needsConfirmation,
  refusedHomeReason,
} from "../../../os/contracts/src/home";

export interface HomeSource extends HomeApi {
  /** "mac": real shortcuts on this Mac. "practice": nothing real changes. */
  kind: "mac" | "practice";
}

export const KIND_ICON: Record<HomeDeviceKind, string> = {
  light: "sparkle",
  tv: "tv",
  fan: "refresh",
  thermostat: "weather",
  blinds: "expand",
  other: "home",
};

export const KIND_WORDS: Record<HomeDeviceKind, string> = {
  light: "Light",
  tv: "TV",
  fan: "Fan",
  thermostat: "Heating or cooling",
  blinds: "Blinds",
  other: "Something else",
};

const onOff = (name: string) => [
  { id: "on", label: "On", shortcut: `${name} on` },
  { id: "off", label: "Off", shortcut: `${name} off` },
];

/** The practice home: made-up devices, in this page only. */
export const PRACTICE_SETUP: HomeSetup = {
  enabled: true,
  devices: [
    { id: "bedroom-light", name: "Bedroom light", kind: "light", actions: onOff("Bedroom light") },
    { id: "tv", name: "TV", kind: "tv", actions: onOff("TV") },
    { id: "fan", name: "Fan", kind: "fan", actions: onOff("Fan") },
    {
      id: "heating",
      name: "Heating",
      kind: "thermostat",
      actions: [
        { id: "warmer", label: "Warmer", shortcut: "Heating warmer", state: "Warmer" },
        { id: "cooler", label: "Cooler", shortcut: "Heating cooler", state: "Cooler" },
        { id: "off", label: "Heating off", shortcut: "Heating off", state: "Off" },
      ],
    },
    {
      id: "blinds",
      name: "Blinds",
      kind: "blinds",
      actions: [
        { id: "open", label: "Open", shortcut: "Blinds open", state: "Open" },
        { id: "close", label: "Close", shortcut: "Blinds close", state: "Closed" },
      ],
    },
  ],
};

function delayMs(): number {
  try {
    const raw = localStorage.getItem("agency.fakeAgentDelayMs");
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) && v >= 0 ? v : 400;
  } catch {
    return 400;
  }
}

/** Same checks as the Mac app's main process, with nothing real behind them. */
export class PracticeHome implements HomeSource {
  readonly kind = "practice" as const;
  private setup: HomeSetup = structuredClone(PRACTICE_SETUP);
  private states: Record<string, HomeState> = {};
  readonly ran: { deviceId: string; actionId: string }[] = [];

  constructor(private readonly wait = delayMs) {}

  async status(): Promise<HomeStatus> {
    return {
      available: true,
      setup: structuredClone(this.setup),
      states: { ...this.states },
    };
  }

  async save(setup: HomeSetup): Promise<HomeSaveResult> {
    const checked = checkHomeSetup(setup);
    if (!checked.ok) return checked;
    this.setup = checked.setup;
    return { ok: true, status: await this.status() };
  }

  async shortcuts(): Promise<HomeShortcutsResult> {
    return { ok: true, names: this.setup.devices.flatMap((d) => d.actions.map((a) => a.shortcut)) };
  }

  async run(deviceId: string, actionId: string, confirmed: boolean): Promise<HomeRunResult> {
    if (!this.setup.enabled) return { ok: false, error: "Home control is off." };
    const device = this.setup.devices.find((d) => d.id === deviceId);
    const action = device?.actions.find((a) => a.id === actionId);
    if (!device || !action) return { ok: false, error: "That isn't one of your devices any more." };
    const refused = refusedHomeReason(device.name, action.label, action.shortcut, action.input);
    if (refused) return { ok: false, error: refused };
    if (needsConfirmation(device, action) && !confirmed)
      return { ok: false, error: `${device.name}: ${action.label} needs your confirmation look first.` };
    await new Promise((r) => setTimeout(r, this.wait()));
    const state = action.state ?? action.label;
    this.states[device.id] = { state, at: Date.now() };
    this.ran.push({ deviceId, actionId });
    return { ok: true, state };
  }
}

let practice: PracticeHome | null = null;

/** The Mac app's home when it has one (not in the web demo or when a test forces the practice home). */
export function homeSource(): HomeSource {
  const real = (window as unknown as { agency?: { home?: HomeApi } }).agency?.home;
  if (real && host() && !webDemo() && !fakeForced("home")) {
    return {
      kind: "mac",
      status: () => real.status(),
      save: (s) => real.save(s),
      shortcuts: () => real.shortcuts(),
      run: (d, a, c) => real.run(d, a, c),
    };
  }
  practice ??= new PracticeHome();
  return practice;
}

/** For tests: forget the practice home's state. */
export function resetPracticeHome(): void {
  practice = null;
}

export function stateLine(device: HomeDevice, states: Record<string, HomeState>): string {
  const s = states[device.id];
  return s ? `Last set: ${s.state}` : "Not changed yet";
}
