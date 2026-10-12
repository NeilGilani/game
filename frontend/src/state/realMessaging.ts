/**
 * Real texts and calls through the person's own iPhone, in the Mac app only (os/desktop/src/main/messaging.ts does
 * the sending). Off until turned on in Settings, Calls and texts. Everywhere else (the browser, the web demo,
 * tests) there is no source and every call and text stays practice.
 *
 * The practice agent (fakeAgent.ts) runs these tasks with its usual approval: before each approval it asks the
 * Mac app for a ticket covering the exact person and words (`bind`), shows the ticket's fingerprint, and only after
 * the person approved that fingerprint sends it (`perform`). Change makes a new ticket; Stop forgets them all.
 * The AI never picks the recipient or sends: it can only name one of the saved people the person chose.
 */
import type { FlowOption } from "../flows/types";
import type {
  CallVia,
  MessagingApi,
  MessagingSettings,
  MessagingStatus,
  RealPerson,
  TextVia,
} from "../../../os/contracts/src/messaging";
import type { TaskRequest } from "./contracts";
import type { RealHooks, Script } from "./fakeAgent";
import { fakeForced, host } from "./host";

export type { MessagingStatus, RealPerson };

/** Selection that marks a real person (their saved contact id). Only set by `realPeopleOptions`. */
export const REAL_CONTACT = "real_contact";

/** Ready-made words the person can switch to with Change (the same as the Messages flow). */
export const TEXT_PHRASES = [
  "I'm OK, no need to come",
  "Can you come by today?",
  "Please call me",
  "Thank you!",
];

const BEFORE_CALL = "Before the call";
const NOTE_YES = "Send a text saying I'm calling";
const NOTE_NO = "No text first";

const OFF: MessagingStatus = {
  available: false,
  reason: "Real calls and texts need the AGENCY Mac app.",
  settings: { enabled: false, textVia: "auto", callVia: "phone" },
  people: [],
};

let override: MessagingApi | null | undefined;

/** Tests only: use this source (null: none), or undefined to look for the Mac app again. */
export function setMessagingForTests(api: MessagingApi | null | undefined): void {
  override = api;
  current = OFF;
}

/** The Mac app's messaging, or null: in a browser, the web demo, or when forced off for tests. */
export function messagingSource(): MessagingApi | null {
  if (override !== undefined) return override;
  if (import.meta.env.VITE_WEB_DEMO === "1") return null;
  if (typeof window === "undefined" || fakeForced("messaging")) return null;
  const h = host() as (ReturnType<typeof host> & { messaging?: MessagingApi }) | null;
  return h?.messaging && typeof h.messaging.prepare === "function" ? h.messaging : null;
}

let current: MessagingStatus = OFF;
const listeners = new Set<(s: MessagingStatus) => void>();

/** What the Mac app said last (real people only while turned on). */
export function realStatus(): MessagingStatus {
  return current;
}

export function onRealStatus(listener: (s: MessagingStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(s: MessagingStatus): MessagingStatus {
  current = s;
  for (const l of [...listeners]) l(s);
  return s;
}

/** Ask the Mac app again. Failures leave real sends off. */
export async function refreshReal(): Promise<MessagingStatus> {
  const src = messagingSource();
  if (!src) return publish(OFF);
  try {
    return publish(await src.status());
  } catch {
    return publish({ ...OFF, reason: "AGENCY couldn't reach the Mac app's Messages connection." });
  }
}

export async function changeRealSettings(change: Partial<MessagingSettings>): Promise<MessagingStatus> {
  const src = messagingSource();
  if (!src) return publish(OFF);
  return publish(await src.setSettings(change));
}

// Keep the saved people fresh: once now, then whenever the screen changes (contacts may have been edited).
let lastRefresh = 0;
function refreshSoon(): void {
  const now = Date.now();
  if (now - lastRefresh < 1500) return;
  lastRefresh = now;
  void refreshReal();
}
if (typeof window !== "undefined" && messagingSource()) {
  refreshSoon();
  window.addEventListener("hashchange", refreshSoon);
}

const ROLE: Record<string, string> = {
  caregiver: "Caregiver",
  family: "Family",
  neighbour: "Neighbour",
  clinician: "Clinician",
  monitoring_service: "Monitoring service",
};

/** The person's real saved people as flow options, labelled Real. Empty while off or outside the Mac app. */
export function realPeopleOptions(next: string): FlowOption[] {
  const s = current;
  if (!s.available || !s.settings.enabled) return [];
  return s.people.map((p) => ({
    id: `real-${p.id}`,
    label: p.name.slice(0, 40),
    sub: `Real · ${ROLE[p.role] ?? "Saved person"}`,
    icon: "name",
    set: { person: p.name, [REAL_CONTACT]: p.id },
    next,
  }));
}

/** Practice people, labelled so nobody mistakes them for real ones. */
export function practiceLabelled(options: FlowOption[]): FlowOption[] {
  return options.map((o) => ({ ...o, sub: o.sub ? `Practice · ${o.sub}` : "Practice" }));
}

function textVia(v: TextVia): string {
  return v === "sms"
    ? "A text message through your iPhone, from your number"
    : "Messages on this Mac: iMessage, or a text through your iPhone";
}

function callVia(v: CallVia): string {
  return v === "facetime" ? "FaceTime audio on this Mac" : "Your iPhone, through this Mac";
}

function refused(reason: string): Script {
  return { steps: [], outcome: "", evidence: "", refuse: reason };
}

/**
 * The script for a call or text to one of the person's real saved people, or null when the task isn't one.
 * Without the Mac app, or while turned off, it refuses: a real person is never quietly turned into practice.
 */
export function realScriptFor(r: TaskRequest): Promise<Script> | null {
  const contactId = r.selections?.[REAL_CONTACT];
  const kind = r.selections?.kind;
  if (!contactId || (kind !== "message" && kind !== "call")) return null;
  return build(r, contactId, kind);
}

async function build(r: TaskRequest, contactId: string, kind: "message" | "call"): Promise<Script> {
  const src = messagingSource();
  const who = r.selections?.person ?? "them";
  if (!src) return refused("Real calls and texts need the AGENCY Mac app. Nothing was sent.");
  const status = await refreshReal();
  if (!status.available)
    return refused(`${status.reason ?? "Real calls and texts aren't available."} Nothing was sent.`);
  if (!status.settings.enabled)
    return refused(
      "Real calls and texts are off, so nothing was sent. They can be turned on in Settings, Calls and texts.",
    );
  if (!status.people.some((p) => p.id === contactId))
    return refused(`${who} isn't one of your saved people with a phone number now. Nothing was sent.`);

  let ticket: { id: string; fingerprint: string } | null = null;
  const forget = () => {
    if (ticket) void src.cancel(ticket.id).catch(() => undefined);
    ticket = null;
  };

  const real: RealHooks = {
    async bind(details) {
      forget();
      const p =
        kind === "message"
          ? await src.prepare({ kind: "text", contactId, text: details.Message ?? "" })
          : await src.prepare({ kind: "call", contactId, textFirst: details[BEFORE_CALL] !== NOTE_NO });
      if (!p.ok) return { error: p.error };
      ticket = { id: p.ticket, fingerprint: p.fingerprint };
      const person = `${p.person.name}`;
      if (kind === "message")
        return {
          fingerprint: p.fingerprint,
          details: {
            To: person,
            Number: p.person.display,
            Message: p.text ?? "",
            Using: textVia(p.via as TextVia),
          },
          preview: p.text ?? "",
        };
      const call: Record<string, string> = {
        Who: person,
        Number: p.person.display,
        [BEFORE_CALL]: p.text ? NOTE_YES : NOTE_NO,
      };
      if (p.text) call["Text first"] = p.text;
      call.Using = callVia(p.via as CallVia);
      return { fingerprint: p.fingerprint, details: call };
    },
    async perform(fingerprint) {
      const t = ticket;
      ticket = null;
      if (!t || t.fingerprint !== fingerprint)
        return { ok: false, reason: "This doesn't match what you approved, so nothing was sent." };
      const done = await src.send(t.id, t.fingerprint).catch((e: unknown) => ({
        ok: false as const,
        error: `The Mac app didn't answer (${e instanceof Error ? e.message : "unknown"}). Look in Messages before trying again.`,
      }));
      if (!done.ok) return { ok: false, reason: done.error };
      if (kind === "message") {
        const how = done.via === "sms" ? "a text message through your iPhone" : "iMessage";
        return {
          ok: true,
          summary: `Sent to ${who} by ${how}.`,
          outcome: `Your text went to ${who} by ${how}, from your own number. Messages shows Delivered once it arrives.`,
          evidence: "Messages on this Mac accepted it.",
        };
      }
      return {
        ok: true,
        summary: "Your Mac is starting the call.",
        outcome: `Calling ${who} through your ${done.via === "facetime" ? "Mac with FaceTime audio" : "iPhone"}. If your Mac asks, look at Call to start it. On the call, open Talk to speak; ${who} may not hear the computer voice well, so texts are the sure way.${done.warning ? ` ${done.warning}` : ""}`,
        evidence: "The Mac took the call request.",
      };
    },
    cancel: forget,
  };

  if (kind === "message") {
    const text = r.selections?.text ?? "";
    return {
      steps: [
        { title: "Write the message", risk: "reversible", summary: "Message written." },
        { title: `Send it to ${who} for real`, risk: "consequential", summary: `Sending to ${who}.` },
      ],
      approvalAt: 1,
      approval: {
        kind: "send",
        summary: `Send this text to ${who} for real, from your own number.`,
        details: { To: who, Message: text },
        preview: text,
      },
      changes: { Message: [...new Set([text, ...TEXT_PHRASES])] },
      outcome: "",
      evidence: "",
      verified: false,
      real,
    };
  }
  return {
    steps: [
      { title: `Find ${who}'s number`, risk: "read", summary: `${who} is one of your saved people.` },
      { title: `Call ${who} for real`, risk: "consequential", summary: `Calling ${who}.` },
    ],
    approvalAt: 1,
    approval: {
      kind: "call",
      summary: `Call ${who} for real through your iPhone. Your Mac then asks to confirm: look at Call. During the call, Talk speaks for you.`,
      details: { Who: who, [BEFORE_CALL]: NOTE_YES },
    },
    changes: { [BEFORE_CALL]: [NOTE_YES, NOTE_NO] },
    outcome: "",
    evidence: "",
    verified: false,
    real,
  };
}
