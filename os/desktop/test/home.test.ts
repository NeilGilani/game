/**
 * The home by eye (src/main/home) with the shortcuts tool faked: off by default, only saved devices, names always
 * after "--", values only through a file, never locks or doors, a confirmation look for heating, one at a time,
 * Stop aborts, and failures are told plainly.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkHomeSetup, needsConfirmation, refusedHomeReason, type HomeSetup } from "@agency/contracts";
import {
  EMPTY_SETUP,
  HomeControl,
  MAX_RUNS_PER_MINUTE,
  homeCall,
  loadHomeSetup,
} from "../src/main/home/control";
import {
  describeRunFailure,
  parseList,
  runArgs,
  writeInputFile,
  type ShortcutsResult,
} from "../src/main/home/shortcuts";
import { deferred, quietLog } from "./helpers";

const SETUP: HomeSetup = {
  enabled: true,
  devices: [
    {
      id: "lamp",
      name: "Bedroom light",
      kind: "light",
      actions: [
        { id: "on", label: "On", shortcut: "Bedroom light on" },
        { id: "off", label: "Off", shortcut: "Bedroom light off" },
      ],
    },
    {
      id: "heat",
      name: "Heating",
      kind: "thermostat",
      actions: [{ id: "warm", label: "Warmer", shortcut: "Set heating", input: "22", state: "22°" }],
    },
  ],
};

const OK: ShortcutsResult = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };

function setup(opts: { platform?: string; setup?: HomeSetup | null; reply?: Partial<ShortcutsResult> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agency-home-"));
  const file = join(dir, "home.json");
  if (opts.setup !== null) writeFileSync(file, JSON.stringify(opts.setup ?? SETUP));
  const calls: { args: string[]; input: string | null; signal?: AbortSignal }[] = [];
  let reply: ShortcutsResult = { ...OK, ...opts.reply };
  let gate: Promise<void> | null = null;
  let now = 1_000_000;
  const removed: string[] = [];
  const home = new HomeControl({
    platform: opts.platform ?? "darwin",
    file,
    run: async (args, _timeout, signal) => {
      const i = args.indexOf("--input-path");
      calls.push({ args, input: i >= 0 ? readFileSync(args[i + 1]!, "utf8") : null, signal });
      if (gate) await gate;
      return signal?.aborted ? { ...reply, code: 15, aborted: true } : reply;
    },
    writeInput: async (text) => {
      const f = await writeInputFile(text);
      return { path: f.path, remove: async () => (removed.push(f.path), f.remove()) };
    },
    log: quietLog(),
    now: () => now,
  });
  return {
    home,
    file,
    calls,
    removed,
    setReply: (r: Partial<ShortcutsResult>) => (reply = { ...OK, ...r }),
    hold: (p: Promise<void> | null) => (gate = p),
    advance: (ms: number) => (now += ms),
  };
}

describe("refusedHomeReason (owner rule: no locks, doors, garage doors or gates)", () => {
  it.each([
    "Front door",
    "Unlock the door",
    "Garage",
    "garage light",
    "FrontDoorUnlock",
    "front_door-lock",
    "Deadbolt",
    "Side gate",
    "Lock",
    "Locks",
    "keypad",
  ])("refuses %s", (name) => expect(refusedHomeReason(name)).toMatch(/never controls locks/));
  it.each([
    "Bedroom light",
    "TV",
    "Fan",
    "Clock radio",
    "Blinds",
    "Doorbell camera light",
    "Heating",
    "Block heater",
  ])("allows %s", (name) => expect(refusedHomeReason(name)).toBeNull());
});

describe("checkHomeSetup", () => {
  it("keeps a good setup, and only an explicit true turns it on", () => {
    const r = checkHomeSetup({ ...SETUP, enabled: "yes" });
    expect(r.ok && r.setup.enabled).toBe(false);
    expect(r.ok && r.setup.devices[1]!.actions[0]).toEqual(SETUP.devices[1]!.actions[0]);
  });

  it("refuses doors anywhere: the device, an action's label, its shortcut or its value", () => {
    const door = structuredClone(SETUP);
    door.devices[0]!.name = "Front door";
    expect(checkHomeSetup(door)).toMatchObject({ ok: false, error: /never controls locks/ });
    const sneaky = structuredClone(SETUP);
    sneaky.devices[0]!.actions[0]!.shortcut = "Unlock everything";
    expect(checkHomeSetup(sneaky)).toMatchObject({ ok: false, error: /never controls locks/ });
    const value = structuredClone(SETUP);
    value.devices[1]!.actions[0]!.input = "garage";
    expect(checkHomeSetup(value)).toMatchObject({ ok: false });
  });

  it("refuses a shortcut name that could be read as an option, bad ids and too many devices", () => {
    const dash = structuredClone(SETUP);
    dash.devices[0]!.actions[0]!.shortcut = "--output-path=/etc/x";
    expect(checkHomeSetup(dash)).toMatchObject({ ok: false, error: /exact name/ });
    const id = structuredClone(SETUP);
    id.devices[0]!.id = "../x";
    expect(checkHomeSetup(id).ok).toBe(false);
    const many = {
      enabled: true,
      devices: Array.from({ length: 13 }, (_, i) => ({ ...SETUP.devices[0]!, id: `d${i}` })),
    };
    expect(checkHomeSetup(many)).toMatchObject({ ok: false, error: /At most 12/ });
    expect(checkHomeSetup(null).ok).toBe(false);
    expect(checkHomeSetup({ devices: [{ ...SETUP.devices[0]!, kind: "door" }] }).ok).toBe(false);
  });

  it("strips control characters", () => {
    const s = structuredClone(SETUP);
    s.devices[0]!.name = "Bed\u0007room light";
    const r = checkHomeSetup(s);
    expect(r.ok && r.setup.devices[0]!.name).toBe("Bedroom light");
  });
});

describe("needsConfirmation", () => {
  it("asks for heating, ovens and anything a helper marked", () => {
    const [lamp, heat] = SETUP.devices as [HomeSetup["devices"][0], HomeSetup["devices"][0]];
    expect(needsConfirmation(lamp, lamp.actions[0]!)).toBe(false);
    expect(needsConfirmation(heat, heat.actions[0]!)).toBe(true);
    expect(needsConfirmation({ ...lamp, name: "Oven plug" }, lamp.actions[1]!)).toBe(true);
    expect(needsConfirmation(lamp, { ...lamp.actions[0]!, confirm: true })).toBe(true);
  });
});

describe("HomeControl", () => {
  it("is off and empty with no saved setup, and refuses to run", async () => {
    const t = setup({ setup: null });
    expect(t.home.status()).toMatchObject({ available: true, setup: EMPTY_SETUP });
    expect(await t.home.run("lamp", "on", false)).toMatchObject({ ok: false, error: /isn't one of|off/ });
    expect(t.calls).toHaveLength(0);
  });

  it("does nothing until a helper turns it on", async () => {
    const t = setup({ setup: { ...SETUP, enabled: false } });
    expect(await t.home.run("lamp", "on", false)).toMatchObject({ ok: false, error: /Home control is off/ });
    expect(t.calls).toHaveLength(0);
  });

  it("needs macOS", async () => {
    const t = setup({ platform: "linux" });
    expect(t.home.status()).toMatchObject({ available: false, reason: /macOS/ });
    expect(await t.home.run("lamp", "on", false)).toMatchObject({ ok: false });
    expect(await t.home.shortcuts()).toMatchObject({ ok: false });
    expect(t.calls).toHaveLength(0);
  });

  it("runs the saved shortcut by name after --, and remembers what it last set", async () => {
    const t = setup();
    expect(await t.home.run("lamp", "on", false)).toEqual({ ok: true, state: "On" });
    expect(t.calls[0]!.args).toEqual(["run", "--", "Bedroom light on"]);
    expect(t.home.status().states.lamp).toEqual({ state: "On", at: 1_000_000 });
  });

  it("only runs saved devices and actions", async () => {
    const t = setup();
    expect(await t.home.run("lamp", "explode", false)).toMatchObject({ ok: false });
    expect(await t.home.run("Bedroom light on", "on", false)).toMatchObject({ ok: false });
    expect(t.calls).toHaveLength(0);
  });

  it("passes a value only through a private temporary file, then removes it", async () => {
    const t = setup();
    expect(await t.home.run("heat", "warm", true)).toEqual({ ok: true, state: "22°" });
    const args = t.calls[0]!.args;
    expect(args.slice(0, 2)).toEqual(["run", "--input-path"]);
    expect(args.slice(3)).toEqual(["--", "Set heating"]);
    expect(args).not.toContain("22");
    expect(t.calls[0]!.input).toBe("22");
    expect(t.removed).toHaveLength(1);
    expect(existsSync(t.removed[0]!)).toBe(false);
  });

  it("needs the confirmation look for heating", async () => {
    const t = setup();
    expect(await t.home.run("heat", "warm", false)).toMatchObject({ ok: false, error: /confirmation look/ });
    expect(await t.home.run("heat", "warm", "yes")).toMatchObject({ ok: false });
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a door even if one was written into the file by hand", async () => {
    const t = setup({ setup: null });
    const bad = structuredClone(SETUP);
    bad.devices[0]!.actions[0]!.shortcut = "Unlock front door";
    writeFileSync(t.file, JSON.stringify(bad));
    expect(loadHomeSetup(t.file)).toEqual(EMPTY_SETUP);
  });

  it("runs one shortcut at a time, and Stop aborts it", async () => {
    const t = setup();
    const gate = deferred<void>();
    t.hold(gate.promise);
    const first = t.home.run("lamp", "on", false);
    await Promise.resolve();
    expect(await t.home.run("lamp", "off", false)).toMatchObject({ ok: false, error: /still changing/ });
    t.home.stopAll();
    gate.resolve();
    expect(await first).toEqual({ ok: false, error: "Stopped." });
    expect(t.calls[0]!.signal?.aborted).toBe(true);
    expect(t.home.status().states.lamp).toBeUndefined();
  });

  it("limits how many changes a minute, without retrying", async () => {
    const t = setup();
    for (let i = 0; i < MAX_RUNS_PER_MINUTE; i++)
      expect((await t.home.run("lamp", "on", false)).ok).toBe(true);
    expect(await t.home.run("lamp", "on", false)).toMatchObject({ ok: false, error: /a lot of changes/ });
    t.advance(61_000);
    expect((await t.home.run("lamp", "on", false)).ok).toBe(true);
    expect(t.calls).toHaveLength(MAX_RUNS_PER_MINUTE + 1);
  });

  it("tells failures plainly and doesn't change the state", async () => {
    const t = setup({
      reply: { code: 1, stderr: "Error: The operation couldn’t be completed. Couldn’t find shortcut" },
    });
    expect(await t.home.run("lamp", "on", false)).toMatchObject({
      ok: false,
      error: /no shortcut called "Bedroom light on"/,
    });
    expect(t.home.status().states).toEqual({});
    t.setReply({ code: null, timedOut: true });
    expect(await t.home.run("lamp", "off", false)).toMatchObject({ ok: false, error: /took too long/ });
    expect(t.calls).toHaveLength(2);
  });

  it("saves a checked setup to its file, refuses a bad one, and forgets states of removed devices", async () => {
    const t = setup();
    await t.home.run("lamp", "on", false);
    const door = structuredClone(SETUP);
    door.devices.push({
      id: "g",
      name: "Garage",
      kind: "other",
      actions: [{ id: "o", label: "Open", shortcut: "Open" }],
    });
    expect(t.home.save(door)).toMatchObject({ ok: false });
    const only = { enabled: true, devices: [SETUP.devices[1]!] };
    expect(t.home.save(only)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(t.file, "utf8"))).toEqual(only);
    expect(t.home.status().states).toEqual({});
  });

  it("lists the Mac's shortcuts", async () => {
    const t = setup({ reply: { stdout: "Bedroom light on\nBedroom light off\n\n" } });
    expect(await t.home.shortcuts()).toEqual({ ok: true, names: ["Bedroom light on", "Bedroom light off"] });
    expect(t.calls[0]!.args).toEqual(["list"]);
  });

  it("answers the shell's operations and rejects unknown ones", async () => {
    const t = setup();
    expect(await homeCall(t.home, "status", [])).toMatchObject({ available: true });
    expect(await homeCall(t.home, "run", ["lamp", "off", false])).toEqual({ ok: true, state: "Off" });
    await expect(homeCall(t.home, "exec", ["rm -rf /"])).rejects.toThrow(/unknown home operation/);
  });
});

describe("shortcuts helpers", () => {
  it("builds argument lists with the name last, after --", () => {
    expect(runArgs("-h", null)).toEqual(["run", "--", "-h"]);
    expect(runArgs("Fan on", "/tmp/a/input.txt")).toEqual([
      "run",
      "--input-path",
      "/tmp/a/input.txt",
      "--",
      "Fan on",
    ]);
  });

  it("describes failures and parses the list", () => {
    expect(describeRunFailure({ ...OK, aborted: true }, "x")).toBe("Stopped.");
    expect(describeRunFailure({ ...OK, code: 1, stderr: "Error: not authorized" }, "x")).toMatch(
      /didn't allow/,
    );
    expect(describeRunFailure({ ...OK, code: 1, stderr: "weird" }, "x")).toMatch(/didn't finish/);
    expect(parseList(" A \n\nB\n")).toEqual(["A", "B"]);
  });
});
