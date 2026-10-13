/**
 * The home's devices for the screen. In the Mac app, once a helper turned home control on and named devices, they
 * are real (os/desktop/src/main/home: Apple Shortcuts, run by the main process only). Everywhere else, and until
 * then, a practice home stands in: its lights and fan change on screen and nowhere else.
 *
 * Either way, every change is prepared first (a ticket for exactly that device and action) and then run with the
 * same fingerprint, and anything marked "confirm" (heating, ovens) waits for a confirmation look in between.
 */
import type {
  HomeApi,
  HomeDeviceView,
  HomePrepareResult,
  HomeRunResult,
  HomeStatus,
} from "../../../os/contracts/src/home";
import { fakeForced, host } from "../state/host";

export type { HomeDeviceView, HomePrepareResult, HomeRunResult };

export interface HomeSource {
  practice: boolean;
  status(): Promise<HomeStatus>;
  refresh(): Promise<HomeStatus>;
  prepare(deviceId: string, actionId: string): Promise<HomePrepareResult>;
  run(ticket: string, fingerprint: string): Promise<HomeRunResult>;
  cancel(ticket: string): Promise<void>;
}

/** The Mac app's home API, or null (a browser, the web demo, an older Mac app, or forced off for tests). */
export function homeApi(): HomeApi | null {
  if (import.meta.env.VITE_WEB_DEMO === "1" || fakeForced("home")) return null;
  const h = host() as (ReturnType<typeof host> & { home?: HomeApi }) | null;
  return h?.home && typeof h.home.prepare === "function" ? h.home : null;
}

interface PracticeDevice {
  view: HomeDeviceView;
  /** What each action changes the state to. */
  states: Record<string, string>;
  inputs?: Record<string, string>;
}

function practiceDevices(): PracticeDevice[] {
  const d = (
    id: string,
    name: string,
    kind: HomeDeviceView["kind"],
    state: string,
    actions: [string, string, string, boolean][],
  ): PracticeDevice => ({
    view: {
      id,
      name,
      kind,
      actions: actions.map(([aid, label, , confirm]) => ({ id: aid, label, confirm })),
      state,
      stateFromDevice: true,
      stateAt: null,
    },
    states: Object.fromEntries(actions.map(([aid, , to]) => [aid, to])),
  });
  return [
    d("bedroom-lamp", "Bedroom lamp", "light", "Off", [
      ["on", "Turn on", "On", false],
      ["off", "Turn off", "Off", false],
    ]),
    d("ceiling", "Ceiling light", "light", "On", [
      ["on", "Turn on", "On", false],
      ["dim", "Dim", "Dimmed", false],
      ["off", "Turn off", "Off", false],
    ]),
    d("tv", "TV", "tv", "Off", [
      ["on", "Turn on", "On", false],
      ["off", "Turn off", "Off", false],
      ["news", "News channel", "News channel", false],
    ]),
    d("fan", "Fan", "fan", "Off", [
      ["low", "Low", "Low", false],
      ["high", "High", "High", false],
      ["off", "Turn off", "Off", false],
    ]),
    d("thermostat", "Thermostat", "thermostat", "20°C", [
      ["warmer", "Warmer, 22°C", "22°C", true],
      ["cooler", "Cooler, 18°C", "18°C", true],
      ["off", "Heating off", "Heating off", true],
    ]),
    d("blinds", "Blinds", "blinds", "Open", [
      ["open", "Open", "Open", false],
      ["close", "Close", "Closed", false],
    ]),
  ];
}

export class PracticeHome implements HomeSource {
  practice = true;
  private devices = practiceDevices();
  private tickets = new Map<string, { fingerprint: string; device: string; action: string }>();
  private n = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async status(): Promise<HomeStatus> {
    return { available: true, enabled: true, devices: this.devices.map((d) => structuredClone(d.view)) };
  }
  refresh() {
    return this.status();
  }
  async prepare(deviceId: string, actionId: string): Promise<HomePrepareResult> {
    const d = this.devices.find((x) => x.view.id === deviceId);
    const a = d?.view.actions.find((x) => x.id === actionId);
    if (!d || !a) return { ok: false, error: "That device or action isn't in the practice home." };
    this.n += 1;
    const ticket = `practice-${this.n}`;
    const fingerprint = `fp-${this.n}-${deviceId}-${actionId}`;
    this.tickets.set(ticket, { fingerprint, device: deviceId, action: actionId });
    return {
      ok: true,
      ticket,
      fingerprint,
      device: d.view.name,
      action: a.label,
      confirm: a.confirm,
      summary: `${a.label}: ${d.view.name}`,
    };
  }
  async run(ticket: string, fingerprint: string): Promise<HomeRunResult> {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.fingerprint !== fingerprint)
      return { ok: false, error: "This doesn't match what you chose, so nothing was changed." };
    const d = this.devices.find((x) => x.view.id === t.device)!;
    const a = d.view.actions.find((x) => x.id === t.action)!;
    d.view.state = d.states[t.action] ?? a.label;
    d.view.stateAt = this.now();
    return { ok: true, state: d.view.state, summary: `${a.label}: ${d.view.name}` };
  }
  async cancel(ticket: string) {
    this.tickets.delete(ticket);
  }
  /** Stop: forget every prepared change. */
  stopAll(): void {
    this.tickets.clear();
  }
}

class MacHome implements HomeSource {
  practice = false;
  constructor(private readonly api: HomeApi) {}
  status() {
    return this.api.status();
  }
  refresh() {
    return this.api.refresh();
  }
  prepare(deviceId: string, actionId: string) {
    return this.api.prepare(deviceId, actionId);
  }
  run(ticket: string, fingerprint: string) {
    return this.api.run(ticket, fingerprint);
  }
  cancel(ticket: string) {
    return this.api.cancel(ticket);
  }
}

let practice: PracticeHome | null = null;

/**
 * The real home when it is turned on with at least one device, otherwise the practice home. Asked fresh each time
 * the home screen opens, so turning it on in Settings takes effect at once.
 */
export async function homeSource(): Promise<{ source: HomeSource; status: HomeStatus; note: string | null }> {
  const api = homeApi();
  if (api) {
    try {
      const status = await api.status();
      if (status.available && status.enabled && status.devices.length)
        return { source: new MacHome(api), status, note: null };
      const why = !status.available
        ? (status.reason ?? "The real home isn't available here.")
        : !status.enabled
          ? "Home control is off, so this is a practice home."
          : "No devices are set up yet, so this is a practice home.";
      practice ??= new PracticeHome();
      return {
        source: practice,
        status: await practice.status(),
        note: `${why} A helper can set it up in Settings, My day.`,
      };
    } catch {
      /* fall through to practice */
    }
  }
  practice ??= new PracticeHome();
  return {
    source: practice,
    status: await practice.status(),
    note: "Practice home: nothing in your home changes. The real home needs the AGENCY Mac app.",
  };
}

/** Stop: forget the practice home's prepared changes (the Mac app's main process clears its own). */
export function stopPracticeHome(): void {
  practice?.stopAll();
}

/** Tests only. */
export function resetHomeForTests(): void {
  practice = null;
}
