/**
 * The home through Apple Shortcuts (src/main/home) with the `shortcuts` program faked: off by default, only named
 * devices, never doors, locks, garages or gates, a run binds the exact ticket, safety devices need a confirmation,
 * Stop and the rate limit hold, failures are told plainly, and names and inputs only ever reach the program as
 * separate arguments.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HomeSettings } from "@agency/contracts";
import { DEFAULT_HOME, FORBIDDEN, loadHome, saveHome, validateHome } from "../src/main/home/config";
import { HomeControl, MAX_RUNS_PER_MINUTE, TICKET_TTL_MS, homeCall } from "../src/main/home/control";
import {
  SHORTCUTS_BIN,
  cleanOutput,
  describeShortcutFailure,
  listShortcuts,
  runArgs,
  type Exec,
  type ExecResult,
} from "../src/main/home/shortcuts";
import { quietLog } from "./helpers";

const LAMP = {
  id: "lamp",
  name: "Bedroom lamp",
  kind: "light" as const,
  actions: [
    { id: "on", label: "Turn on", shortcut: "Lamp On", confirm: false },
    { id: "off", label: "Turn off", shortcut: "Lamp Off", confirm: false },
  ],
  statusShortcut: "Lamp Status",
};
const HEAT = {
  id: "heat",
  name: "Thermostat",
  kind: "thermostat" as const,
  actions: [{ id: "set21", label: "Set to", shortcut: "Set Heat", input: "21", confirm: false }],
};

const HOSTILE = `Lamp"; rm -rf ~; echo "`;

interface Call {
  file: string;
  args: string[];
  input: string | null;
}

function setup(
  opts: { platform?: string; enabled?: boolean; reply?: Partial<ExecResult>; output?: string } = {},
) {
  let settings: HomeSettings = validateHome({ enabled: opts.enabled ?? true, devices: [LAMP, HEAT] });
  let now = 1_000_000;
  const calls: Call[] = [];
  let reply: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, ...opts.reply };
  let output: string | undefined = opts.output;
  let hold: Promise<void> | null = null;
  const killed: string[] = [];
  const exec: Exec = (file, args) => {
    const inputAt = args.indexOf("--input-path");
    const outAt = args.indexOf("--output-path");
    const input = inputAt >= 0 ? readFileSync(args[inputAt + 1]!, "utf8") : null;
    calls.push({ file, args, input });
    const child = {
      kill: () => killed.push(args[1]!),
    } as unknown as import("node:child_process").ChildProcess;
    const done = (async () => {
      if (hold) await hold;
      if (outAt >= 0 && output !== undefined && reply.code === 0) writeFileSync(args[outAt + 1]!, output);
      return reply;
    })();
    return { child, done };
  };
  const dir = mkdtempSync(join(tmpdir(), "agency-home-test-"));
  const logFile = join(dir, "home-actions.jsonl");
  const home = new HomeControl({
    platform: opts.platform ?? "darwin",
    settings: () => settings,
    saveSettings: (s) => (settings = s),
    exec,
    logFile,
    log: quietLog(),
    now: () => now,
  });
  return {
    home,
    calls,
    killed,
    logFile,
    advance: (ms: number) => (now += ms),
    setReply: (r: Partial<ExecResult>) => (reply = { ...reply, ...r }),
    setOutput: (o: string | undefined) => (output = o),
    holdRuns: () => {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
    settings: () => settings,
  };
}

async function choose(h: ReturnType<typeof setup>, device: string, action: string) {
  const p = h.home.prepare(device, action);
  if (!p.ok) throw new Error(p.error);
  return h.home.run(p.ticket, p.fingerprint);
}

describe("home setup", () => {
  it("is off with no devices by default, and only an explicit true turns it on", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-home-cfg-"));
    expect(loadHome(join(dir, "missing.json"))).toEqual(DEFAULT_HOME);
    expect(validateHome({ enabled: "yes", devices: [] }).enabled).toBe(false);
    const file = join(dir, "home.json");
    saveHome(file, validateHome({ enabled: true, devices: [LAMP] }));
    expect(loadHome(file).devices[0]!.name).toBe("Bedroom lamp");
    writeFileSync(file, "{not json");
    expect(loadHome(file)).toEqual(DEFAULT_HOME);
    // A file edited by hand to add a door is not loaded at all.
    writeFileSync(file, JSON.stringify({ enabled: true, devices: [{ ...LAMP, name: "Front door" }] }));
    expect(loadHome(file)).toEqual(DEFAULT_HOME);
  });

  it("never accepts doors, locks, garage doors or gates, wherever the word appears", () => {
    const bad = [
      { ...LAMP, name: "Front door" },
      { ...LAMP, name: "Garage" },
      { ...LAMP, actions: [{ id: "u", label: "Unlock", shortcut: "Lamp On", confirm: false }] },
      { ...LAMP, actions: [{ id: "o", label: "Open", shortcut: "Open Gate", confirm: false }] },
      { ...LAMP, actions: [{ id: "o", label: "Go", shortcut: "Lamp", input: "lock", confirm: false }] },
      { ...LAMP, statusShortcut: "Door Status" },
    ];
    for (const d of bad)
      expect(() => validateHome({ enabled: true, devices: [d] })).toThrow(/never controls doors/);
    // Whole words only: these are fine.
    for (const ok of ["Clock radio", "Indoor fan", "Block heater", "Entryway light"])
      expect(FORBIDDEN.test(ok)).toBe(false);
  });

  it("checks names, ids and limits, and makes heating always ask for a confirmation", () => {
    expect(() => validateHome({ enabled: true, devices: [{ ...LAMP, kind: "robot" }] })).toThrow(/what kind/);
    expect(() => validateHome({ enabled: true, devices: [{ ...LAMP, actions: [] }] })).toThrow(
      /at least one/,
    );
    expect(() => validateHome({ enabled: true, devices: [LAMP, LAMP] })).toThrow(/same id/);
    expect(() =>
      validateHome({
        enabled: true,
        devices: [{ ...LAMP, actions: [{ ...LAMP.actions[0], shortcut: "--help" }] }],
      }),
    ).toThrow(/start with "-"/);
    expect(() => validateHome({ enabled: true, devices: [{ ...LAMP, id: "Bad Id" }] })).toThrow(/id/);
    const s = validateHome({ enabled: true, devices: [{ ...LAMP, name: "  Bedroom\n lamp " }, HEAT] });
    expect(s.devices[0]!.name).toBe("Bedroom lamp");
    expect(s.devices[1]!.actions[0]!.confirm).toBe(true);
    expect(s.devices[0]!.actions[0]!.confirm).toBe(false);
  });
});

describe("running shortcuts", () => {
  it("passes the name and input as separate arguments, never through a shell", async () => {
    expect(runArgs(HOSTILE, "/tmp/in.txt", "/tmp/out.txt")).toEqual([
      "run",
      HOSTILE,
      "--input-path",
      "/tmp/in.txt",
      "--output-path",
      "/tmp/out.txt",
      "--output-type",
      "public.plain-text",
    ]);
    const h = setup();
    const r = await choose(h, "heat", "set21");
    expect(r.ok).toBe(true);
    expect(h.calls[0]!.file).toBe(SHORTCUTS_BIN);
    expect(h.calls[0]!.args.slice(0, 2)).toEqual(["run", "Set Heat"]);
    expect(h.calls[0]!.input).toBe("21");
    // The temporary files are gone afterwards.
    const inputPath = h.calls[0]!.args[h.calls[0]!.args.indexOf("--input-path") + 1]!;
    expect(existsSync(inputPath)).toBe(false);
  });

  it("keeps a shortcut's output as the state, or the action's name when it says nothing", async () => {
    const h = setup({ output: "On\n" });
    expect(await choose(h, "lamp", "on")).toEqual({
      ok: true,
      state: "On",
      summary: "Turn on: Bedroom lamp",
    });
    expect(h.home.status().devices[0]).toMatchObject({ state: "On", stateFromDevice: true });
    h.setOutput(undefined);
    await choose(h, "lamp", "off");
    expect(h.home.status().devices[0]).toMatchObject({ state: "Turn off", stateFromDevice: false });
    expect(cleanOutput("  21\u0007 °C \n\n")).toBe("21 °C");
    expect(cleanOutput("")).toBeNull();
  });

  it("refresh runs each status shortcut", async () => {
    const h = setup({ output: "Off" });
    const s = await h.home.refresh();
    expect(h.calls.map((c) => c.args[1])).toEqual(["Lamp Status"]);
    expect(s.devices[0]!.state).toBe("Off");
  });

  it("says plainly what went wrong, and never tries again", async () => {
    const h = setup({ reply: { code: 1, stderr: "Error: Couldn't find shortcut" } });
    const r = await choose(h, "lamp", "on");
    expect(r).toEqual({ ok: false, error: expect.stringContaining('no shortcut called "Lamp On"') });
    expect(h.calls).toHaveLength(1);
    expect(describeShortcutFailure({ code: null, stdout: "", stderr: "", timedOut: true }, "X")).toMatch(
      /too long/,
    );
    expect(
      describeShortcutFailure({ code: 1, stdout: "", stderr: "not allowed", timedOut: false }, "X"),
    ).toMatch(/didn't let/);
    const lines = readFileSync(h.logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { ok: boolean });
    expect(lines).toEqual([expect.objectContaining({ device: "lamp", action: "on", ok: false })]);
  });

  it("lists the shortcuts on this Mac", async () => {
    const exec: Exec = () => ({
      child: null,
      done: Promise.resolve({ code: 0, stdout: "Lamp On\nLamp Off\n\n", stderr: "", timedOut: false }),
    });
    expect(await listShortcuts(exec)).toEqual({ ok: true, names: ["Lamp On", "Lamp Off"] });
  });
});

describe("the rules", () => {
  it("does nothing while off, or outside a Mac", async () => {
    const off = setup({ enabled: false });
    expect(off.home.status()).toMatchObject({ available: true, enabled: false, devices: [] });
    expect(off.home.prepare("lamp", "on")).toEqual({ ok: false, error: expect.stringContaining("off") });
    const linux = setup({ platform: "linux" });
    expect(linux.home.status().available).toBe(false);
    expect(linux.home.prepare("lamp", "on").ok).toBe(false);
    expect(off.calls).toHaveLength(0);
    expect(linux.calls).toHaveLength(0);
  });

  it("runs only a prepared ticket with its fingerprint, once", async () => {
    const h = setup();
    const p = h.home.prepare("lamp", "on");
    if (!p.ok) throw new Error(p.error);
    expect(p).toMatchObject({ device: "Bedroom lamp", action: "Turn on", confirm: false });
    expect(await h.home.run(p.ticket, "wrong")).toMatchObject({ ok: false });
    // A wrong fingerprint uses the ticket up.
    expect(await h.home.run(p.ticket, p.fingerprint)).toMatchObject({ ok: false });
    expect(h.calls).toHaveLength(0);
    expect(h.home.prepare("lamp", "explode")).toMatchObject({ ok: false });
    expect(h.home.prepare("door", "on")).toMatchObject({ ok: false });
  });

  it("marks safety actions for a confirmation and lets tickets run out", async () => {
    const h = setup();
    const p = h.home.prepare("heat", "set21");
    expect(p).toMatchObject({ ok: true, confirm: true, summary: "Set to (21): Thermostat" });
    if (!p.ok) return;
    h.advance(TICKET_TTL_MS + 1);
    expect(await h.home.run(p.ticket, p.fingerprint)).toEqual({
      ok: false,
      error: expect.stringContaining("ran out"),
    });
    expect(h.calls).toHaveLength(0);
  });

  it("refuses when the setup changed after the choice was shown", async () => {
    const h = setup();
    const p = h.home.prepare("lamp", "on");
    if (!p.ok) throw new Error(p.error);
    h.home.setSettings({
      enabled: true,
      devices: [
        { ...LAMP, actions: [{ id: "on", label: "Turn on", shortcut: "Something Else", confirm: false }] },
      ],
    });
    expect(await h.home.run(p.ticket, p.fingerprint)).toMatchObject({ ok: false });
    expect(h.calls).toHaveLength(0);
    // Saving a door through the API is refused and changes nothing.
    const bad = h.home.setSettings({ enabled: true, devices: [{ ...LAMP, name: "Garage door" }] });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("never controls doors") });
    expect(h.settings().devices[0]!.actions[0]!.shortcut).toBe("Something Else");
  });

  it("one run at a time per device, and a few runs a minute", async () => {
    const h = setup();
    const release = h.holdRuns();
    const first = choose(h, "lamp", "on");
    expect(await choose(h, "lamp", "off")).toEqual({
      ok: false,
      error: expect.stringContaining("Still working"),
    });
    release();
    expect((await first).ok).toBe(true);
    for (let i = 1; i < MAX_RUNS_PER_MINUTE; i++) expect((await choose(h, "lamp", "on")).ok).toBe(true);
    expect(await choose(h, "lamp", "on")).toEqual({
      ok: false,
      error: expect.stringContaining("a lot of changes"),
    });
    h.advance(60_001);
    expect((await choose(h, "lamp", "on")).ok).toBe(true);
  });

  it("Stop ends a running shortcut and forgets every ticket", async () => {
    const h = setup();
    const waiting = h.home.prepare("heat", "set21");
    const release = h.holdRuns();
    const running = choose(h, "lamp", "on");
    h.home.stopAll();
    expect(h.killed).toEqual(["Lamp On"]);
    release();
    expect(await running).toEqual({ ok: false, error: expect.stringContaining("Stopped") });
    expect(h.home.pending).toBe(0);
    if (waiting.ok) expect((await h.home.run(waiting.ticket, waiting.fingerprint)).ok).toBe(false);
  });

  it("answers only the known operations", async () => {
    const h = setup();
    expect(homeCall(h.home, "status", [])).toMatchObject({ enabled: true });
    expect(() => homeCall(h.home, "runAnything", ["rm -rf /"])).toThrow(/unknown/);
  });
});
