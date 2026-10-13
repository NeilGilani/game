/**
 * The home, by eye: runs the named Apple Shortcuts a helper set up for each device (os/contracts/src/home.ts).
 *
 * Rules (owner's standing rules):
 * - Off until a helper turns it on. macOS only.
 * - A window names a device and an action by id; the shortcut's name comes from the saved setup, never from a
 *   window. The setup is checked again here, on load, on save and before every run.
 * - Never locks, doors, garage doors or gates (`refusedHomeReason`).
 * - Heating, ovens and anything a helper marked need the person's confirmation look (`needsConfirmation`).
 * - One shortcut at a time, a few a minute, no automatic retries, and Stop aborts a running one.
 * - The setup lives in <userData>/home.json on this Mac.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  checkHomeSetup,
  needsConfirmation,
  refusedHomeReason,
  type HomeRunResult,
  type HomeSaveResult,
  type HomeSetup,
  type HomeShortcutsResult,
  type HomeState,
  type HomeStatus,
} from "@agency/contracts";
import type { Logger } from "../log";
import {
  LIST_ARGS,
  LIST_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  describeRunFailure,
  parseList,
  runArgs,
  type InputFile,
  type ShortcutsRunner,
} from "./shortcuts";

export const MAX_RUNS_PER_MINUTE = 12;

export const EMPTY_SETUP: HomeSetup = { enabled: false, devices: [] };

export interface HomeDeps {
  platform: string;
  /** Where the setup is kept (<userData>/home.json). */
  file: string;
  run: ShortcutsRunner;
  writeInput: (text: string) => Promise<InputFile>;
  log: Logger;
  now?: () => number;
}

/** The saved setup, checked; anything unreadable or invalid is the empty, switched-off setup. */
export function loadHomeSetup(file: string): HomeSetup {
  if (!existsSync(file)) return structuredClone(EMPTY_SETUP);
  try {
    const checked = checkHomeSetup(JSON.parse(readFileSync(file, "utf8")));
    return checked.ok ? checked.setup : structuredClone(EMPTY_SETUP);
  } catch {
    return structuredClone(EMPTY_SETUP);
  }
}

export class HomeControl {
  private setup: HomeSetup;
  private readonly states: Record<string, HomeState> = {};
  private running: AbortController | null = null;
  private runs: number[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: HomeDeps) {
    this.setup = loadHomeSetup(deps.file);
    this.now = deps.now ?? Date.now;
  }

  private get available(): boolean {
    return this.deps.platform === "darwin";
  }

  status(): HomeStatus {
    return {
      available: this.available,
      ...(this.available
        ? {}
        : { reason: "Home control uses Apple Shortcuts, so it needs the Mac app on macOS." }),
      setup: structuredClone(this.setup),
      states: { ...this.states },
    };
  }

  save(raw: unknown): HomeSaveResult {
    const checked = checkHomeSetup(raw);
    if (!checked.ok) return checked;
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(checked.setup, null, 2), { mode: 0o600 });
      renameSync(tmp, this.deps.file);
    } catch (err) {
      this.deps.log.warn(`home: couldn't save the setup: ${(err as Error).message}`);
      return { ok: false, error: "Couldn't save the home setup on this Mac." };
    }
    this.setup = checked.setup;
    for (const id of Object.keys(this.states))
      if (!this.setup.devices.some((d) => d.id === id)) delete this.states[id];
    this.deps.log.info(`home: setup saved (${this.setup.devices.length} devices, on: ${this.setup.enabled})`);
    return { ok: true, status: this.status() };
  }

  async shortcuts(): Promise<HomeShortcutsResult> {
    if (!this.available) return { ok: false, error: this.status().reason! };
    const r = await this.deps.run(LIST_ARGS, LIST_TIMEOUT_MS);
    if (r.code !== 0) return { ok: false, error: "Couldn't list the shortcuts on this Mac." };
    return { ok: true, names: parseList(r.stdout) };
  }

  async run(deviceId: unknown, actionId: unknown, confirmed: unknown): Promise<HomeRunResult> {
    if (!this.available) return { ok: false, error: this.status().reason! };
    if (!this.setup.enabled)
      return {
        ok: false,
        error: "Home control is off. A helper can turn it on in Settings, My day and home.",
      };
    const device = this.setup.devices.find((d) => d.id === deviceId);
    const action = device?.actions.find((a) => a.id === actionId);
    if (!device || !action) return { ok: false, error: "That isn't one of your devices any more." };
    const refused = refusedHomeReason(device.name, action.label, action.shortcut, action.input);
    if (refused) return { ok: false, error: refused };
    if (needsConfirmation(device, action) && confirmed !== true)
      return { ok: false, error: `${device.name}: ${action.label} needs your confirmation look first.` };
    if (this.running) return { ok: false, error: "Another device is still changing. Try again in a moment." };
    const now = this.now();
    this.runs = this.runs.filter((t) => now - t < 60_000);
    if (this.runs.length >= MAX_RUNS_PER_MINUTE)
      return { ok: false, error: "That's a lot of changes in a minute. Wait a moment, then try again." };
    this.runs.push(now);

    const controller = new AbortController();
    this.running = controller;
    let input: InputFile | null = null;
    try {
      if (action.input !== undefined) input = await this.deps.writeInput(action.input);
      const r = await this.deps.run(
        runArgs(action.shortcut, input?.path ?? null),
        RUN_TIMEOUT_MS,
        controller.signal,
      );
      if (r.code !== 0 || r.aborted) {
        this.deps.log.warn(
          `home: ${device.id}/${action.id} failed (code ${r.code}${r.timedOut ? ", timed out" : ""})`,
        );
        return { ok: false, error: describeRunFailure(r, action.shortcut) };
      }
      const state = action.state ?? action.label;
      this.states[device.id] = { state, at: this.now() };
      this.deps.log.info(`home: ${device.id}/${action.id} ran`);
      return { ok: true, state };
    } catch (err) {
      this.deps.log.warn(`home: ${device.id}/${action.id}: ${(err as Error).message}`);
      return { ok: false, error: `"${action.shortcut}" couldn't start. Nothing more was tried.` };
    } finally {
      this.running = null;
      await input?.remove().catch(() => undefined);
    }
  }

  /** Stop: abort a shortcut that is still running. */
  stopAll(): void {
    this.running?.abort();
  }
}

/** The shell's calls, by operation name (IPC.home). */
export function homeCall(home: HomeControl, op: string, args: unknown[]): Promise<unknown> {
  if (op === "status") return Promise.resolve(home.status());
  if (op === "save") return Promise.resolve(home.save(args[0]));
  if (op === "shortcuts") return home.shortcuts();
  if (op === "run") return home.run(args[0], args[1], args[2]);
  return Promise.reject(new Error("unknown home operation"));
}
