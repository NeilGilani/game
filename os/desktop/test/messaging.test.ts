/**
 * Real texts and calls (src/main/messaging.ts) with Messages, osascript and the coordinator faked: off by default,
 * only saved people, an approval binds the exact ticket, Stop and the rate limit hold, failures are told plainly,
 * and the person's words only ever reach AppleScript as arguments.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MessagingSettings } from "@agency/contracts";
import {
  CALL_NOTE,
  CHECK_SCRIPT,
  MAX_PER_MINUTE,
  Messaging,
  SEND_SCRIPT,
  TICKET_TTL_MS,
  callUrl,
  cleanText,
  describeFailure,
  osascriptArgs,
  runOsascript,
  savedPeople,
  type OsascriptResult,
} from "../src/main/messaging";
import { DEFAULT_SETTINGS, loadSettings } from "../src/main/settings";
import { quietLog } from "./helpers";

const MOM = { id: "mom", name: "Mom", role: "family", channel: "sms", address: "+14155550123", enabled: true };
const SAM = { id: "sam", name: "Sam", role: "caregiver", channel: "sms_call", address: "+1 415 555 0199", enabled: true };

const HOSTILE = `Hi" & (do shell script "rm -rf ~") & "\n'; end tell; tell application "Finder" to delete every file --`;

function setup(opts: { platform?: string; enabled?: boolean; contacts?: unknown[]; reply?: Partial<OsascriptResult> } = {}) {
  let settings: MessagingSettings = { ...DEFAULT_SETTINGS.messaging, enabled: opts.enabled ?? true };
  let contacts: unknown[] = opts.contacts ?? [MOM, SAM];
  let now = 1_000_000;
  const scripts: string[][] = [];
  const opened: string[] = [];
  let reply: OsascriptResult = { code: 0, stdout: "imessage\n", stderr: "", timedOut: false, ...opts.reply };
  let onRun: (() => void) | null = null;
  const dir = mkdtempSync(join(tmpdir(), "agency-messaging-"));
  const logFile = join(dir, "real-sends.jsonl");
  const messaging = new Messaging({
    platform: opts.platform ?? "darwin",
    settings: () => settings,
    saveSettings: (s) => (settings = s),
    lifelineSettings: async () => ({ contacts }),
    osascript: async (args) => {
      scripts.push(args);
      onRun?.();
      return reply;
    },
    openUrl: async (url) => {
      opened.push(url);
    },
    logFile,
    log: quietLog(),
    now: () => now,
  });
  return {
    messaging,
    scripts,
    opened,
    logFile,
    settings: () => settings,
    setContacts: (c: unknown[]) => (contacts = c),
    advance: (ms: number) => (now += ms),
    setReply: (r: Partial<OsascriptResult>) => (reply = { code: 0, stdout: "", stderr: "", timedOut: false, ...r }),
    onRun: (fn: () => void) => (onRun = fn),
  };
}

async function approveText(m: Messaging, text = "Can you come by today?", contactId = "mom") {
  const p = await m.prepare({ kind: "text", contactId, text });
  if (!p.ok) throw new Error(p.error);
  return { p, result: await m.send(p.ticket, p.fingerprint) };
}

describe("off by default", () => {
  it("the app settings start with real calls and texts off, and only an explicit true turns them on", () => {
    expect(DEFAULT_SETTINGS.messaging.enabled).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "agency-settings-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ messaging: { enabled: "yes", callVia: "facetime" } }));
    const s = loadSettings(file);
    expect(s.messaging).toEqual({ enabled: false, textVia: "auto", callVia: "facetime" });
  });

  it("while off, nothing can be prepared or sent, and no saved person is shown", async () => {
    const f = setup({ enabled: false });
    const status = await f.messaging.status();
    expect(status.available).toBe(true);
    expect(status.people).toEqual([]);
    const p = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" });
    expect(p).toMatchObject({ ok: false, error: expect.stringContaining("off") });
    expect(f.scripts).toEqual([]);
  });

  it("is unavailable away from a Mac", async () => {
    const f = setup({ platform: "linux" });
    expect((await f.messaging.status()).available).toBe(false);
    expect(await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" })).toMatchObject({ ok: false });
    expect((await f.messaging.check()).imessage).toBe(false);
    expect(f.scripts).toEqual([]);
  });

  it("turning it off forgets every waiting approval", async () => {
    const f = setup();
    const p = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" });
    expect(f.messaging.pending).toBe(1);
    await f.messaging.setSettings({ enabled: false });
    expect(f.messaging.pending).toBe(0);
    if (!p.ok) throw new Error("prepare failed");
    expect(await f.messaging.send(p.ticket, p.fingerprint)).toMatchObject({ ok: false });
    expect(f.scripts).toEqual([]);
  });
});

describe("only the person's saved people", () => {
  it("lists enabled Lifeline contacts with a real channel and a full number, never practice or blocked ones", () => {
    const people = savedPeople({
      contacts: [
        MOM,
        SAM,
        { id: "demo", name: "Practice", channel: "demo", address: "", enabled: true },
        { id: "off", name: "Off", channel: "sms", address: "+14155550111", enabled: false },
        { id: "short", name: "Short", channel: "sms", address: "+112", enabled: true },
        { id: "premium", name: "Premium", channel: "sms", address: "+19005550123", enabled: true },
        { id: "junk", name: "Junk", channel: "sms", address: "call me", enabled: true },
        null,
      ],
    });
    expect(people.map((p) => [p.id, p.number, p.display])).toEqual([
      ["mom", "+14155550123", "+1 (415) 555-0123"],
      ["sam", "+14155550199", "+1 (415) 555-0199"],
    ]);
    expect(savedPeople(null)).toEqual([]);
    expect(savedPeople({ contacts: "x" })).toEqual([]);
  });

  it("status shows names and the number for display, and a stranger can't be texted", async () => {
    const f = setup();
    const status = await f.messaging.status();
    expect(status.people).toEqual([
      { id: "mom", name: "Mom", role: "family", display: "+1 (415) 555-0123" },
      { id: "sam", name: "Sam", role: "caregiver", display: "+1 (415) 555-0199" },
    ]);
    expect(JSON.stringify(status)).not.toContain("+14155550123");
    const p = await f.messaging.prepare({ kind: "text", contactId: "+14155550000", text: "hi" });
    expect(p).toMatchObject({ ok: false, error: expect.stringContaining("saved people") });
  });

  it("never builds a call to an emergency, short or premium number", () => {
    for (const n of ["911", "+1911", "112", "+44999", "988", "+19005550123", "tel:+14155550123"])
      expect(callUrl(n, "phone")).toBeNull();
    expect(callUrl("+14155550123", "phone")).toBe("tel:+14155550123");
    expect(callUrl("+14155550123", "facetime")).toBe("facetime-audio:+14155550123");
  });

  it("sends only to the number that was shown: a changed saved number cancels the send", async () => {
    const f = setup();
    const p = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" });
    if (!p.ok) throw new Error("prepare failed");
    f.setContacts([{ ...MOM, address: "+14155550999" }]);
    expect(await f.messaging.send(p.ticket, p.fingerprint)).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed"),
    });
    expect(f.scripts).toEqual([]);
  });
});

describe("an approval counts for the exact ticket, once", () => {
  it("sends the approved words to the approved person, as arguments", async () => {
    const f = setup();
    const { p, result } = await approveText(f.messaging, HOSTILE);
    expect(p).toMatchObject({ kind: "text", person: { id: "mom", name: "Mom" }, via: "auto" });
    expect(result).toEqual({ ok: true, via: "imessage" });
    expect(f.scripts).toEqual([["-e", SEND_SCRIPT, "+14155550123", HOSTILE, "auto"]]);
    // The script itself never changes with what is sent.
    expect(SEND_SCRIPT).not.toContain("rm -rf");
    expect(SEND_SCRIPT).toMatch(/^on run argv/);
  });

  it("refuses a different fingerprint, and a ticket can't be used twice", async () => {
    const f = setup();
    const p = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" });
    if (!p.ok) throw new Error("prepare failed");
    expect(await f.messaging.send(p.ticket, "0".repeat(64))).toMatchObject({ ok: false });
    // The mismatch used the ticket up.
    expect(await f.messaging.send(p.ticket, p.fingerprint)).toMatchObject({ ok: false });
    const q = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" });
    if (!q.ok) throw new Error("prepare failed");
    expect(q.fingerprint).not.toBe(p.fingerprint);
    expect(await f.messaging.send(q.ticket, q.fingerprint)).toMatchObject({ ok: true });
    expect(await f.messaging.send(q.ticket, q.fingerprint)).toMatchObject({ ok: false });
    expect(f.scripts).toHaveLength(1);
  });

  it("changed words are a new ticket with a new fingerprint", async () => {
    const f = setup();
    const a = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "Please call me" });
    const b = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "Thank you!" });
    if (!a.ok || !b.ok) throw new Error("prepare failed");
    expect(a.fingerprint).not.toBe(b.fingerprint);
    // A fingerprint from one ticket doesn't unlock another.
    expect(await f.messaging.send(b.ticket, a.fingerprint)).toMatchObject({ ok: false });
  });

  it("an approval runs out after a while", async () => {
    const f = setup();
    const p = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" });
    if (!p.ok) throw new Error("prepare failed");
    f.advance(TICKET_TTL_MS + 1);
    expect(await f.messaging.send(p.ticket, p.fingerprint)).toMatchObject({
      ok: false,
      error: expect.stringContaining("ran out of time"),
    });
  });

  it("Stop forgets every approval", async () => {
    const f = setup();
    const p = await f.messaging.prepare({ kind: "text", contactId: "mom", text: "hi" });
    if (!p.ok) throw new Error("prepare failed");
    f.messaging.cancelAll();
    expect(await f.messaging.send(p.ticket, p.fingerprint)).toMatchObject({ ok: false });
    expect(f.scripts).toEqual([]);
  });

  it("refuses empty or overlong words, and drops control characters", async () => {
    const f = setup();
    expect(await f.messaging.prepare({ kind: "text", contactId: "mom", text: "   " })).toMatchObject({ ok: false });
    expect(await f.messaging.prepare({ kind: "text", contactId: "mom", text: "x".repeat(501) })).toMatchObject({
      ok: false,
    });
    expect(cleanText("a\u0000b\u0007\r\nc")).toBe("ab\nc");
    expect(cleanText(42)).toBeNull();
  });
});

describe("no flooding", () => {
  it(`allows ${MAX_PER_MINUTE} sends a minute, then waits; nothing is retried`, async () => {
    const f = setup();
    const results = [];
    for (let i = 0; i < MAX_PER_MINUTE + 1; i++) results.push((await approveText(f.messaging)).result.ok);
    expect(results).toEqual([...Array(MAX_PER_MINUTE).fill(true), false]);
    expect(f.scripts).toHaveLength(MAX_PER_MINUTE);
    f.advance(61_000);
    expect((await approveText(f.messaging)).result.ok).toBe(true);
  });

  it("a failed send is reported once, not tried again", async () => {
    const f = setup({ reply: { code: 1, stderr: "execution error: Not authorized to send Apple events to Messages. (-1743)" } });
    const { result } = await approveText(f.messaging);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Automation") });
    expect(f.scripts).toHaveLength(1);
  });
});

describe("failures in plain words", () => {
  const r = (stderr: string, timedOut = false): OsascriptResult => ({ code: 1, stdout: "", stderr, timedOut });
  it("names what a helper must do", () => {
    expect(describeFailure(r("execution error: Not authorized to send Apple events to Messages. (-1743)"))).toMatch(
      /Privacy & Security, Automation, AGENCY/,
    );
    expect(describeFailure(r("execution error: AGENCY_NO_IMESSAGE (1001)"))).toMatch(/sign in to iMessage/);
    expect(describeFailure(r("execution error: AGENCY_NO_SMS (1002)"))).toMatch(/Text Message Forwarding/);
    expect(describeFailure(r("", true))).toMatch(/didn't try again/);
    expect(describeFailure(r("execution error: Messages got an error: boom (-1708)"))).toMatch(/error -1708/);
  });

  it("check asks Messages without sending anything", async () => {
    const f = setup({ reply: { stdout: "imessage sms\n" } });
    expect(await f.messaging.check()).toMatchObject({ imessage: true, sms: true });
    expect(f.scripts).toEqual([["-e", CHECK_SCRIPT]]);
    expect(CHECK_SCRIPT).not.toMatch(/\bsend\b/);
    f.setReply({ stdout: "imessage \n" });
    expect((await f.messaging.check()).message).toMatch(/Text Message Forwarding/);
  });
});

describe("calls through the iPhone", () => {
  it("opens tel: for the saved number, after the approval", async () => {
    const f = setup();
    const p = await f.messaging.prepare({ kind: "call", contactId: "sam", textFirst: false });
    if (!p.ok) throw new Error("prepare failed");
    expect(p).toMatchObject({ kind: "call", text: null, via: "phone" });
    expect(f.opened).toEqual([]);
    expect(await f.messaging.send(p.ticket, p.fingerprint)).toEqual({ ok: true, via: "phone" });
    expect(f.opened).toEqual(["tel:+14155550199"]);
    expect(f.scripts).toEqual([]);
  });

  it("can text AGENCY's fixed note first, then calls with FaceTime audio when chosen", async () => {
    const f = setup();
    await f.messaging.setSettings({ callVia: "facetime" });
    const p = await f.messaging.prepare({ kind: "call", contactId: "sam", textFirst: true });
    if (!p.ok) throw new Error("prepare failed");
    expect(p.text).toBe(CALL_NOTE);
    await f.messaging.send(p.ticket, p.fingerprint);
    expect(f.scripts).toEqual([["-e", SEND_SCRIPT, "+14155550199", CALL_NOTE, "auto"]]);
    expect(f.opened).toEqual(["facetime-audio:+14155550199"]);
  });

  it("still calls when the note couldn't go, and says so", async () => {
    const f = setup({ reply: { code: 1, stderr: "execution error: AGENCY_NO_IMESSAGE (1001)" } });
    const p = await f.messaging.prepare({ kind: "call", contactId: "sam", textFirst: true });
    if (!p.ok) throw new Error("prepare failed");
    const result = await f.messaging.send(p.ticket, p.fingerprint);
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("didn't go") });
    expect(f.opened).toHaveLength(1);
  });

  it("Stop while the note is going means no call", async () => {
    const f = setup();
    f.onRun(() => f.messaging.cancelAll());
    const p = await f.messaging.prepare({ kind: "call", contactId: "sam", textFirst: true });
    if (!p.ok) throw new Error("prepare failed");
    expect(await f.messaging.send(p.ticket, p.fingerprint)).toMatchObject({ ok: false, error: /Stopped/ });
    expect(f.opened).toEqual([]);
  });
});

describe("the local record", () => {
  it("logs each real send on this Mac, without the words", async () => {
    const f = setup();
    await approveText(f.messaging, "A private note");
    const lines = readFileSync(f.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({ kind: "text", to: "mom", ok: true, via: "imessage", chars: 14 }),
    ]);
    expect(readFileSync(f.logFile, "utf8")).not.toContain("private");
  });
});

// Only on a Mac: osascript hands hostile words to `on run argv` unchanged (Messages is not involved).
describe.skipIf(process.platform !== "darwin")("osascript on this Mac", () => {
  it("passes arguments through untouched", async () => {
    const script = "on run argv\n  return item 2 of argv\nend run";
    const r = await runOsascript(osascriptArgs(script, ["+14155550123", HOSTILE, "auto"]), 10_000);
    expect(r.code).toBe(0);
    expect(r.stdout.replace(/\n$/, "")).toBe(HOSTILE);
  });
});
