/**
 * Real texts and calls through the person's own iPhone, from the main process only.
 *
 * - Texts: the Mac's Messages app through AppleScript (osascript). iMessage, or a text message through the iPhone's
 *   Text Message Forwarding. The number and the words are passed as arguments to `on run argv`, never written into
 *   the script, so no text can change what the script does.
 * - Calls: a `tel:` (or `facetime-audio:`) address, which the Mac hands to the paired iPhone (Continuity). macOS then
 *   asks to confirm the call.
 *
 * Rules (owner's standing rules: nothing real goes out by default):
 * - Off until turned on in Settings (`MessagingSettings.enabled`, default false).
 * - Only the person's saved people with a phone number (Lifeline contacts on the coordinator). The number is looked
 *   up here; a window can only name a saved person by id.
 * - Never emergency or crisis numbers (os/tasks phone policy): Lifeline is for emergencies.
 * - Every send needs a ticket from `prepare`, shown to the person with its fingerprint, and the same fingerprint
 *   back. A ticket is used once, runs out after a few minutes, and Stop clears every ticket.
 * - At most a few sends a minute; no automatic retries.
 * - Each send is logged on this Mac only (without the words).
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CallVia,
  MessagingCheck,
  MessagingSettings,
  MessagingStatus,
  PrepareRequest,
  PrepareResult,
  RealPerson,
  SendResult,
  TextVia,
} from "@agency/contracts";
import { checkOutgoingNumber, formatDisplay } from "../../../tasks/src/policy/phone";
import type { Logger } from "./log";

export const MAX_PER_MINUTE = 3;
export const MAX_PER_HOUR = 20;
export const TICKET_TTL_MS = 10 * 60_000;
export const MAX_TEXT = 500;
const MAX_PENDING = 8;
const OSASCRIPT_TIMEOUT_MS = 30_000;

/** The note sent before a call when the person asks for it. Fixed words, shown on the approval. */
export const CALL_NOTE =
  "I'm calling you now through AGENCY, the computer I use with my eyes. I'll answer with a computer voice. If you can't hear it, please text me and I'll write back.";

/**
 * Sends argv[2] to argv[1]. argv[3] is "auto" (iMessage, else a text message through the iPhone) or "sms".
 * Errors 1001 and 1002 are AGENCY's own: no iMessage account, no text message service.
 */
export const SEND_SCRIPT = [
  "on run argv",
  "  if (count of argv) is not 3 then error \"AGENCY_BAD_ARGUMENTS\" number 1000",
  "  set theNumber to item 1 of argv",
  "  set theText to item 2 of argv",
  "  set theMode to item 3 of argv",
  '  tell application "Messages"',
  '    if theMode is not "sms" then',
  "      set theAccount to missing value",
  "      try",
  "        set theAccount to 1st account whose service type = iMessage",
  "      on error errText number errNum",
  "        if errNum is -1743 then error errText number errNum",
  "      end try",
  "      if theAccount is not missing value then",
  "        send theText to participant theNumber of theAccount",
  '        return "imessage"',
  "      end if",
  "    end if",
  "    try",
  "      set theAccount to 1st account whose service type = SMS",
  "    on error errText number errNum",
  "      if errNum is -1743 then error errText number errNum",
  '      if theMode is "sms" then error "AGENCY_NO_SMS" number 1002',
  '      error "AGENCY_NO_IMESSAGE" number 1001',
  "    end try",
  "    send theText to participant theNumber of theAccount",
  '    return "sms"',
  "  end tell",
  "end run",
].join("\n");

/** Which services Messages has, without sending anything. */
export const CHECK_SCRIPT = [
  "on run argv",
  '  set found to ""',
  '  tell application "Messages"',
  "    try",
  "      set a to 1st account whose service type = iMessage",
  '      set found to found & "imessage "',
  "    on error errText number errNum",
  "      if errNum is -1743 then error errText number errNum",
  "    end try",
  "    try",
  "      set a to 1st account whose service type = SMS",
  '      set found to found & "sms"',
  "    on error errText number errNum",
  "      if errNum is -1743 then error errText number errNum",
  "    end try",
  "  end tell",
  "  return found",
  "end run",
].join("\n");

/** The osascript argument list: the fixed script, then the values as separate arguments for `on run argv`. */
export function osascriptArgs(script: string, values: string[]): string[] {
  return ["-e", script, ...values];
}

export interface OsascriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type OsascriptRunner = (args: string[], timeoutMs: number) => Promise<OsascriptResult>;

/** The real runner: /usr/bin/osascript with an argument vector (no shell). */
export const runOsascript: OsascriptRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? e?.message ?? ""),
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });

const NOT_ALLOWED =
  "AGENCY isn't allowed to use Messages yet. A helper can allow it: System Settings, Privacy & Security, Automation, AGENCY, then switch on Messages.";
const NO_IMESSAGE =
  "Messages on this Mac isn't set up to send. A helper can sign in to iMessage (Messages, Settings, iMessage), or turn on Text Message Forwarding on the iPhone.";
const NO_SMS =
  "This Mac can't send text messages through the iPhone yet. A helper can turn it on: on the iPhone, Settings, Apps, Messages, Text Message Forwarding, then switch on this Mac.";

/** osascript's failure in plain words, with what a helper must do. */
export function describeFailure(r: OsascriptResult): string {
  if (r.timedOut)
    return "Messages took too long to answer. AGENCY didn't try again. Look in Messages to see whether it went.";
  const num = /\((-?\d+)\)\s*$/m.exec(r.stderr.trim())?.[1];
  if (num === "-1743") return NOT_ALLOWED;
  if (num === "1001") return NO_IMESSAGE;
  if (num === "1002") return NO_SMS;
  if (num === "-600" || num === "-609")
    return "Messages didn't answer. Open Messages once, then try again.";
  return `Messages couldn't send it${num ? ` (error ${num})` : ""}. Nothing more was tried.`;
}

/** Saved person with the number, which never leaves the main process. */
export interface SavedPerson extends RealPerson {
  number: string;
}

/**
 * The person's saved people who can be texted or called for real: Lifeline contacts that are on and have a real
 * channel (text, or text and call) with a full phone number. Practice ("demo") contacts and emergency or short
 * numbers are left out.
 */
export function savedPeople(lifelineSettings: unknown): SavedPerson[] {
  const contacts = (lifelineSettings as { contacts?: unknown })?.contacts;
  if (!Array.isArray(contacts)) return [];
  const out: SavedPerson[] = [];
  for (const c of contacts as Record<string, unknown>[]) {
    if (!c || typeof c !== "object" || c.enabled === false) continue;
    if (c.channel !== "sms" && c.channel !== "sms_call") continue;
    if (typeof c.id !== "string" || typeof c.name !== "string" || typeof c.address !== "string") continue;
    const number = c.address.replace(/\s/g, "");
    if (!/^\+[1-9]\d{6,14}$/.test(number)) continue;
    if (!checkOutgoingNumber(number).ok) continue;
    out.push({
      id: c.id,
      name: c.name.slice(0, 60),
      role: typeof c.role === "string" ? c.role : "contact",
      number,
      display: formatDisplay(number),
    });
  }
  return out;
}

/** The address a call opens: a phone call through the iPhone, or FaceTime audio. Null for anything not allowed. */
export function callUrl(number: string, via: CallVia): string | null {
  if (!/^\+[1-9]\d{6,14}$/.test(number)) return null;
  if (!checkOutgoingNumber(number).ok) return null;
  return via === "facetime" ? `facetime-audio:${number}` : `tel:${number}`;
}

/** Words for a text: trimmed, at most MAX_TEXT characters, no control characters except new lines. */
export function cleanText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
  if (!t || t.length > MAX_TEXT) return null;
  return t;
}

/** Sends in the last minute and hour; refuses past the limits. */
export class RateLimit {
  private times: number[] = [];
  constructor(
    private readonly perMinute = MAX_PER_MINUTE,
    private readonly perHour = MAX_PER_HOUR,
  ) {}
  take(now: number): string | null {
    this.times = this.times.filter((t) => now - t < 3_600_000);
    const lastMinute = this.times.filter((t) => now - t < 60_000).length;
    if (lastMinute >= this.perMinute)
      return `AGENCY already sent ${lastMinute} in the last minute. So nobody gets flooded, wait a minute and try again. Nothing was sent.`;
    if (this.times.length >= this.perHour)
      return `AGENCY already sent ${this.times.length} in the last hour. So nobody gets flooded, wait a while. Nothing was sent.`;
    this.times.push(now);
    return null;
  }
}

interface Ticket {
  fingerprint: string;
  kind: "text" | "call";
  person: SavedPerson;
  text: string | null;
  via: TextVia | CallVia;
  expiresAt: number;
}

export interface MessagingDeps {
  platform: string;
  settings: () => MessagingSettings;
  saveSettings: (settings: MessagingSettings) => void;
  /** The coordinator's Lifeline settings (GET /api/lifeline/settings). */
  lifelineSettings: () => Promise<unknown>;
  osascript: OsascriptRunner;
  openUrl: (url: string) => Promise<void>;
  /** Local record of real sends (JSON lines), or null for none. */
  logFile: string | null;
  log: Logger;
  now?: () => number;
}

const OFF = "Real calls and texts are off. Nothing was sent. They can be turned on in Settings, Calls and texts.";

export class Messaging {
  private readonly tickets = new Map<string, Ticket>();
  private readonly limit = new RateLimit();
  /** Bumped by Stop: a call waiting on its note is not placed after a Stop. */
  private generation = 0;

  constructor(private readonly deps: MessagingDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get available(): boolean {
    return this.deps.platform === "darwin";
  }

  private unavailableReason(): string {
    return "Real calls and texts need the AGENCY Mac app on a Mac with Messages and a paired iPhone.";
  }

  private async people(): Promise<SavedPerson[]> {
    return savedPeople(await this.deps.lifelineSettings());
  }

  async status(): Promise<MessagingStatus> {
    const settings = { ...this.deps.settings() };
    if (!this.available) return { available: false, reason: this.unavailableReason(), settings, people: [] };
    let people: SavedPerson[] = [];
    if (settings.enabled) people = await this.people().catch(() => []);
    return { available: true, settings, people: people.map(publicPerson) };
  }

  async setSettings(change: Partial<MessagingSettings>): Promise<MessagingStatus> {
    const s = { ...this.deps.settings() };
    if (typeof change.enabled === "boolean") s.enabled = change.enabled;
    if (change.textVia === "auto" || change.textVia === "sms") s.textVia = change.textVia;
    if (change.callVia === "phone" || change.callVia === "facetime") s.callVia = change.callVia;
    this.deps.saveSettings(s);
    if (!s.enabled) this.cancelAll();
    this.deps.log.info(
      `real calls and texts ${s.enabled ? "on" : "off"} (texts: ${s.textVia}, calls: ${s.callVia})`,
    );
    return this.status();
  }

  async check(): Promise<MessagingCheck> {
    if (!this.available) return { imessage: false, sms: false, message: this.unavailableReason() };
    const r = await this.deps.osascript(osascriptArgs(CHECK_SCRIPT, []), OSASCRIPT_TIMEOUT_MS);
    if (r.code !== 0) return { imessage: false, sms: false, message: describeFailure(r) };
    const imessage = /imessage/.test(r.stdout);
    const sms = /sms/.test(r.stdout);
    const message =
      imessage && sms
        ? "Messages is ready: iMessage, and text messages through the iPhone."
        : imessage
          ? "Messages is ready for iMessage. Text messages to people without iMessage need Text Message Forwarding on the iPhone."
          : sms
            ? "Messages can send text messages through the iPhone. iMessage isn't signed in."
            : NO_IMESSAGE;
    return { imessage, sms, message };
  }

  async prepare(req: PrepareRequest): Promise<PrepareResult> {
    if (!this.available) return { ok: false, error: this.unavailableReason() };
    const settings = this.deps.settings();
    if (!settings.enabled) return { ok: false, error: OFF };
    if (!req || (req.kind !== "text" && req.kind !== "call") || typeof req.contactId !== "string")
      return { ok: false, error: "That request isn't complete. Nothing was sent." };
    let people: SavedPerson[];
    try {
      people = await this.people();
    } catch {
      return { ok: false, error: "AGENCY couldn't read your saved people just now. Nothing was sent." };
    }
    const person = people.find((p) => p.id === req.contactId);
    if (!person)
      return {
        ok: false,
        error: "That isn't one of your saved people with a phone number. Nothing was sent.",
      };
    const check = checkOutgoingNumber(person.number);
    if (!check.ok) return { ok: false, error: check.message };

    let text: string | null;
    let via: TextVia | CallVia;
    if (req.kind === "text") {
      text = cleanText(req.text);
      if (!text) return { ok: false, error: `A text needs 1 to ${MAX_TEXT} characters. Nothing was sent.` };
      via = settings.textVia;
    } else {
      text = req.textFirst ? CALL_NOTE : null;
      via = settings.callVia;
    }
    this.prune();
    const ticket = randomBytes(16).toString("hex");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([ticket, req.kind, person.id, person.number, text, via]))
      .digest("hex");
    this.tickets.set(ticket, {
      fingerprint,
      kind: req.kind,
      person,
      text,
      via,
      expiresAt: this.now() + TICKET_TTL_MS,
    });
    return { ok: true, ticket, fingerprint, kind: req.kind, person: publicPerson(person), text, via };
  }

  async send(ticket: string, fingerprint: string): Promise<SendResult> {
    const t = typeof ticket === "string" ? this.tickets.get(ticket) : undefined;
    // A ticket is used once, whatever happens next.
    if (typeof ticket === "string") this.tickets.delete(ticket);
    if (!t || typeof fingerprint !== "string" || t.fingerprint !== fingerprint)
      return { ok: false, error: "This doesn't match what you approved, so nothing was sent." };
    if (this.now() > t.expiresAt)
      return { ok: false, error: "That approval ran out of time, so nothing was sent. Start again." };
    if (!this.available) return { ok: false, error: this.unavailableReason() };
    if (!this.deps.settings().enabled) return { ok: false, error: OFF };
    // The saved number may have changed since the approval was shown: send only to the number that was shown.
    let still: SavedPerson | undefined;
    try {
      still = (await this.people()).find((p) => p.id === t.person.id);
    } catch {
      return { ok: false, error: "AGENCY couldn't read your saved people just now. Nothing was sent." };
    }
    if (!still || still.number !== t.person.number)
      return { ok: false, error: `${t.person.name}'s saved number changed. Nothing was sent. Start again.` };
    const limited = this.limit.take(this.now());
    if (limited) return { ok: false, error: limited };

    const gen = this.generation;
    const result =
      t.kind === "text"
        ? await this.text(t.person.number, t.text!, t.via as TextVia)
        : await this.call(t, gen);
    this.record(t, result);
    return result;
  }

  private async text(number: string, text: string, via: TextVia): Promise<SendResult> {
    const r = await this.deps.osascript(osascriptArgs(SEND_SCRIPT, [number, text, via]), OSASCRIPT_TIMEOUT_MS);
    if (r.code !== 0) return { ok: false, error: describeFailure(r) };
    return { ok: true, via: r.stdout.trim() === "sms" ? "sms" : "imessage" };
  }

  private async call(t: Ticket, gen: number): Promise<SendResult> {
    const url = callUrl(t.person.number, t.via as CallVia);
    if (!url) return { ok: false, error: "That number can't be called from AGENCY." };
    let warning: string | undefined;
    if (t.text) {
      const note = await this.text(t.person.number, t.text, this.deps.settings().textVia);
      if (!note.ok) warning = `The text before the call didn't go: ${note.error}`;
      if (gen !== this.generation) return { ok: false, error: "Stopped. The call was not placed." };
    }
    try {
      await this.deps.openUrl(url);
    } catch (err) {
      return {
        ok: false,
        error: `The Mac couldn't start the call (${(err as Error).message}). A helper can check FaceTime, Settings, Calls from iPhone.`,
      };
    }
    return { ok: true, via: t.via, ...(warning ? { warning } : {}) };
  }

  cancel(ticket: string): void {
    if (typeof ticket === "string") this.tickets.delete(ticket);
  }

  /** Stop: forget every ticket, and don't place a call that is waiting on its note. */
  cancelAll(): void {
    this.tickets.clear();
    this.generation += 1;
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

  private record(t: Ticket, result: SendResult): void {
    const line = {
      at: new Date(this.now()).toISOString(),
      kind: t.kind,
      to: t.person.id,
      name: t.person.name,
      via: result.ok ? result.via : t.via,
      ok: result.ok,
      ...(result.ok ? (result.warning ? { warning: result.warning } : {}) : { error: result.error }),
      // The words stay in Messages; the log keeps only their length and a digest.
      ...(t.text
        ? { chars: t.text.length, digest: createHash("sha256").update(t.text).digest("hex").slice(0, 16) }
        : {}),
    };
    this.deps.log.info(`real ${t.kind} to ${t.person.id}: ${result.ok ? `ok via ${line.via}` : "failed"}`);
    if (!this.deps.logFile) return;
    try {
      mkdirSync(dirname(this.deps.logFile), { recursive: true });
      appendFileSync(this.deps.logFile, JSON.stringify(line) + "\n");
    } catch (err) {
      this.deps.log.warn(`could not write the send log: ${(err as Error).message}`);
    }
  }
}

function publicPerson(p: SavedPerson): RealPerson {
  return { id: p.id, name: p.name, role: p.role, display: p.display };
}
