/**
 * The home, by eye, from the main process only (contract: os/contracts/src/home.ts).
 *
 * Rules (owner's standing rules: nothing real happens by default):
 * - Off until a helper turns it on in Settings (`HomeSettings.enabled`, default false), and only on a Mac.
 * - Only the devices and shortcuts a helper named. A window names a device and action by id; the shortcut is
 *   looked up here.
 * - No doors, locks, garage doors or gates: refused when saved (config.ts) and again before every run.
 * - Every run needs a ticket from `prepare` and its fingerprint back. A ticket is used once and runs out after a
 *   couple of minutes. Thermostats, heaters and actions a helper marked are shown on a confirmation screen first.
 * - One run at a time per device, a few runs a minute, no automatic retries. Stop ends a running shortcut and
 *   forgets every ticket.
 * - Each run is logged on this Mac only.
 */

import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  HomeActionDef,
  HomeDeviceDef,
  HomeDeviceView,
  HomePrepareResult,
  HomeRunResult,
  HomeSaveResult,
  HomeSettings,
  HomeShortcutsResult,
  HomeStatus,
} from "@agency/contracts";
import type { Logger } from "../log";
import { FORBIDDEN, FORBIDDEN_MESSAGE, HomeConfigError, validateHome } from "./config";
import { listShortcuts, runShortcut, type Exec } from "./shortcuts";

export const TICKET_TTL_MS = 2 * 60_000;
export const MAX_RUNS_PER_MINUTE = 12;
const MAX_PENDING = 8;

const OFF = "Home control is off. A helper can turn it on in Settings, My day.";

interface Ticket {
  fingerprint: string;
  deviceId: string;
  actionId: string;
  /** The shortcut and input that were shown, so a later settings change can't swap what runs. */
  shortcut: string;
  input: string | undefined;
  expiresAt: number;
}

interface Known {
  state: string | null;
  fromDevice: boolean;
  at: number;
}

export interface HomeDeps {
  platform: string;
  settings: () => HomeSettings;
  saveSettings: (settings: HomeSettings) => void;
  exec: Exec;
  logFile: string | null;
  log: Logger;
  now?: () => number;
}

/** "Turn on" + "Bedroom lamp" -> "Turn on: Bedroom lamp" (with a fixed input: "Set to (21): Thermostat"). */
export function summarize(device: HomeDeviceDef, action: HomeActionDef): string {
  const what = action.input ? ` (${action.input})` : "";
  return `${action.label}${what}: ${device.name}`;
}

export class HomeControl {
  private readonly tickets = new Map<string, Ticket>();
  private readonly running = new Map<string, ChildProcess | null>();
  private readonly known = new Map<string, Known>();
  private runs: number[] = [];
  private generation = 0;

  constructor(private readonly deps: HomeDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get available(): boolean {
    return this.deps.platform === "darwin";
  }

  private view(d: HomeDeviceDef): HomeDeviceView {
    const k = this.known.get(d.id);
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      actions: d.actions.map((a) => ({ id: a.id, label: a.label, confirm: a.confirm })),
      state: k?.state ?? null,
      stateFromDevice: k?.fromDevice ?? false,
      stateAt: k?.at ?? null,
    };
  }

  status(): HomeStatus {
    const s = this.deps.settings();
    if (!this.available)
      return {
        available: false,
        reason: "Home control needs the AGENCY Mac app.",
        enabled: false,
        devices: [],
      };
    return {
      available: true,
      enabled: s.enabled,
      devices: s.enabled ? s.devices.map((d) => this.view(d)) : [],
    };
  }

  settings(): HomeSettings {
    return structuredClone(this.deps.settings());
  }

  setSettings(raw: unknown): HomeSaveResult {
    let next: HomeSettings;
    try {
      next = validateHome(raw);
    } catch (err) {
      if (err instanceof HomeConfigError) return { ok: false, error: err.message };
      throw err;
    }
    this.deps.saveSettings(next);
    // A changed setup voids anything prepared under the old one.
    this.tickets.clear();
    for (const id of [...this.known.keys()])
      if (!next.devices.some((d) => d.id === id)) this.known.delete(id);
    this.deps.log.info(`home control ${next.enabled ? "on" : "off"}, ${next.devices.length} devices`);
    return { ok: true, settings: structuredClone(next) };
  }

  async shortcuts(): Promise<HomeShortcutsResult> {
    if (!this.available) return { ok: false, error: "Shortcuts need the AGENCY Mac app on a Mac." };
    return listShortcuts(this.deps.exec);
  }

  /** Run each device's status shortcut (one at a time), keeping what they say. */
  async refresh(): Promise<HomeStatus> {
    const s = this.deps.settings();
    if (!this.available || !s.enabled) return this.status();
    const gen = this.generation;
    for (const d of s.devices) {
      if (!d.statusShortcut || FORBIDDEN.test(d.statusShortcut) || this.running.has(d.id)) continue;
      if (gen !== this.generation) break;
      const run = runShortcut(this.deps.exec, d.statusShortcut, undefined);
      this.running.set(d.id, run.child);
      const r = await run.done.finally(() => this.running.delete(d.id));
      if (r.ok && r.output) this.known.set(d.id, { state: r.output, fromDevice: true, at: this.now() });
    }
    return this.status();
  }

  private find(
    deviceId: unknown,
    actionId: unknown,
  ): { device: HomeDeviceDef; action: HomeActionDef } | null {
    const device = this.deps.settings().devices.find((d) => d.id === deviceId);
    const action = device?.actions.find((a) => a.id === actionId);
    return device && action ? { device, action } : null;
  }

  prepare(deviceId: unknown, actionId: unknown): HomePrepareResult {
    if (!this.available) return { ok: false, error: "Home control needs the AGENCY Mac app." };
    if (!this.deps.settings().enabled) return { ok: false, error: OFF };
    const found = this.find(deviceId, actionId);
    if (!found)
      return { ok: false, error: "That device or action isn't set up any more. Nothing was changed." };
    const { device, action } = found;
    if ([device.name, action.label, action.shortcut, action.input ?? ""].some((v) => FORBIDDEN.test(v)))
      return { ok: false, error: FORBIDDEN_MESSAGE };
    this.prune();
    const ticket = randomBytes(16).toString("hex");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([ticket, device.id, action.id, action.shortcut, action.input ?? null]))
      .digest("hex");
    this.tickets.set(ticket, {
      fingerprint,
      deviceId: device.id,
      actionId: action.id,
      shortcut: action.shortcut,
      input: action.input,
      expiresAt: this.now() + TICKET_TTL_MS,
    });
    return {
      ok: true,
      ticket,
      fingerprint,
      device: device.name,
      action: action.label,
      confirm: action.confirm,
      summary: summarize(device, action),
    };
  }

  async run(ticket: unknown, fingerprint: unknown): Promise<HomeRunResult> {
    const t = typeof ticket === "string" ? this.tickets.get(ticket) : undefined;
    if (typeof ticket === "string") this.tickets.delete(ticket);
    if (!t || typeof fingerprint !== "string" || t.fingerprint !== fingerprint)
      return { ok: false, error: "This doesn't match what you chose, so nothing was changed." };
    if (this.now() > t.expiresAt)
      return { ok: false, error: "That choice ran out of time. Nothing was changed." };
    if (!this.available) return { ok: false, error: "Home control needs the AGENCY Mac app." };
    if (!this.deps.settings().enabled) return { ok: false, error: OFF };
    // The setup may have changed since the choice was shown: run only exactly what was shown.
    const found = this.find(t.deviceId, t.actionId);
    if (!found || found.action.shortcut !== t.shortcut || found.action.input !== t.input)
      return { ok: false, error: "The setup for this device changed. Nothing was changed; choose again." };
    if (FORBIDDEN.test(t.shortcut) || (t.input && FORBIDDEN.test(t.input)))
      return { ok: false, error: FORBIDDEN_MESSAGE };
    if (this.running.has(t.deviceId))
      return { ok: false, error: `Still working on the ${found.device.name}. Wait a moment.` };
    const now = this.now();
    this.runs = this.runs.filter((x) => now - x < 60_000);
    if (this.runs.length >= MAX_RUNS_PER_MINUTE)
      return { ok: false, error: "That's a lot of changes in a minute. Wait a moment, then try again." };
    this.runs.push(now);

    const gen = this.generation;
    const run = runShortcut(this.deps.exec, t.shortcut, t.input);
    this.running.set(t.deviceId, run.child);
    const r = await run.done.finally(() => this.running.delete(t.deviceId));
    const summary = summarize(found.device, found.action);
    let result: HomeRunResult;
    if (gen !== this.generation)
      result = { ok: false, error: "Stopped. AGENCY stopped waiting for the shortcut; check the device." };
    else if (!r.ok) result = { ok: false, error: r.error };
    else {
      const state = r.output ?? found.action.label;
      this.known.set(t.deviceId, { state, fromDevice: r.output !== null, at: this.now() });
      result = { ok: true, state, summary };
    }
    this.record(t, result);
    return result;
  }

  cancel(ticket: unknown): void {
    if (typeof ticket === "string") this.tickets.delete(ticket);
  }

  /** Stop: end any running shortcut and forget every ticket. */
  stopAll(): void {
    this.generation += 1;
    this.tickets.clear();
    for (const child of this.running.values()) {
      try {
        child?.kill("SIGTERM");
      } catch {
        /* already finished */
      }
    }
  }

  /** For tests. */
  get pending(): number {
    return this.tickets.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, t] of this.tickets) if (now > t.expiresAt) this.tickets.delete(id);
    while (this.tickets.size >= MAX_PENDING) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
  }

  private record(t: Ticket, result: HomeRunResult): void {
    const line = {
      at: new Date(this.now()).toISOString(),
      device: t.deviceId,
      action: t.actionId,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
    };
    this.deps.log.info(`home ${t.deviceId}/${t.actionId}: ${result.ok ? "ok" : "failed"}`);
    if (!this.deps.logFile) return;
    try {
      mkdirSync(dirname(this.deps.logFile), { recursive: true });
      appendFileSync(this.deps.logFile, JSON.stringify(line) + "\n");
    } catch (err) {
      this.deps.log.warn(`could not write the home log: ${(err as Error).message}`);
    }
  }
}

/** The IPC operations the shell may call. */
export function homeCall(home: HomeControl, op: string, args: unknown[]): Promise<unknown> | unknown {
  if (op === "status") return home.status();
  if (op === "refresh") return home.refresh();
  if (op === "settings") return home.settings();
  if (op === "setSettings") return home.setSettings(args[0]);
  if (op === "shortcuts") return home.shortcuts();
  if (op === "prepare") return home.prepare(args[0], args[1]);
  if (op === "run") return home.run(args[0], args[1]);
  if (op === "cancel") {
    home.cancel(args[0]);
    return undefined;
  }
  throw new Error("unknown home operation");
}
