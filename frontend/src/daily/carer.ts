/**
 * "Tell my carer": non-urgent requests to one chosen carer, separate from Lifeline's emergency path.
 *
 * With a coordinator: /api/daily (backend/agency/daily). Off until turned on; `prepare` returns the exact words,
 * who gets them and how; `send` sends exactly that, once. It goes through Lifeline's channels: a simulated phone
 * for practice contacts, a real text only for a real number on a coordinator with Twilio, never a call.
 *
 * In practice mode (web demo, tests) a practice carer's phone on this page stands in. Nobody is contacted.
 */
import { accessToken, ApiError, coordinatorUrl } from "../api/client";
import { practiceMode } from "./store";

export interface CarerPerson {
  id: string;
  name: string;
  role: string;
  channel: string;
  simulated: boolean;
  /** How it gets there, in plain words. */
  how: string;
}

export interface CarerSettings {
  notify_enabled: boolean;
  carer_id: string | null;
  enabled_at: string | null;
}

export interface CarerView {
  settings: CarerSettings;
  carer: CarerPerson | null;
  contacts: CarerPerson[];
  twilio_configured: boolean;
}

export type RequestKind = "help" | "routine" | "day";

export interface Prepared {
  ticket: string;
  to: CarerPerson;
  body: string;
  expires_in_s: number;
}

export interface Sent {
  status: string;
  simulated: boolean;
  error: string | null;
  to: CarerPerson;
}

export interface SentMessage {
  id: number;
  created_at: string;
  kind: string;
  contact_id: string;
  contact_name: string;
  body: string;
  status: string;
  simulated: boolean;
}

export interface CarerSource {
  kind: "coordinator" | "practice";
  view(): Promise<CarerView>;
  save(settings: Pick<CarerSettings, "notify_enabled" | "carer_id">): Promise<CarerView>;
  prepare(kind: RequestKind, text: string): Promise<Prepared>;
  send(ticket: string): Promise<Sent>;
  cancel(ticket: string): Promise<void>;
  messages(): Promise<SentMessage[]>;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const token = accessToken();
  if (token) headers.set("X-Agency-Token", token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try {
    response = await fetch(`${coordinatorUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Can't reach the coordinator. Nothing was sent.", 0, true);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status}). Nothing was sent.`;
    try {
      const b = (await response.json()) as { detail?: unknown };
      if (typeof b.detail === "string") detail = b.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, response.status, false);
  }
  return (await response.json()) as T;
}

export const coordinatorCarer: CarerSource = {
  kind: "coordinator",
  view: () => call("GET", "/api/daily/settings"),
  save: (s) => call("PUT", "/api/daily/settings", s),
  prepare: (kind, text) => call("POST", "/api/daily/prepare", { kind, text }),
  send: (ticket) => call("POST", "/api/daily/send", { ticket }),
  cancel: async (ticket) => {
    await call("POST", "/api/daily/cancel", { ticket }).catch(() => undefined);
  },
  messages: async () => (await call<{ messages: SentMessage[] }>("GET", "/api/daily/messages")).messages,
};

const PRACTICE_CARER: CarerPerson = {
  id: "practice",
  name: "Jordan",
  role: "caregiver",
  channel: "demo",
  simulated: true,
  how: "a practice phone on this page (nobody is really contacted)",
};

/** The practice carer: on from the start (nothing real can happen), kept in this page only. */
export class PracticeCarer implements CarerSource {
  readonly kind = "practice" as const;
  private settings: CarerSettings = { notify_enabled: true, carer_id: null, enabled_at: null };
  private tickets = new Map<string, Prepared>();
  readonly sent: SentMessage[] = [];

  async view(): Promise<CarerView> {
    return {
      settings: { ...this.settings },
      carer: PRACTICE_CARER,
      contacts: [PRACTICE_CARER],
      twilio_configured: false,
    };
  }

  async save(s: Pick<CarerSettings, "notify_enabled" | "carer_id">): Promise<CarerView> {
    this.settings = { notify_enabled: s.notify_enabled, carer_id: null, enabled_at: null };
    if (!s.notify_enabled) this.tickets.clear();
    return this.view();
  }

  async prepare(_kind: RequestKind, text: string): Promise<Prepared> {
    if (!this.settings.notify_enabled) throw new ApiError("Telling a carer is off.", 409, false);
    const words = text.replace(/\s+/g, " ").trim().slice(0, 160);
    const p: Prepared = {
      ticket: `practice-${this.sent.length}-${Math.random().toString(36).slice(2)}`,
      to: PRACTICE_CARER,
      body: `The person you care for (not urgent): ${words}\nSent from AGENCY. Nothing else will follow.`,
      expires_in_s: 300,
    };
    this.tickets.set(p.ticket, p);
    return p;
  }

  async send(ticket: string): Promise<Sent> {
    const p = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!p) throw new ApiError("That request ran out or was already sent. Nothing was sent.", 409, false);
    this.sent.unshift({
      id: this.sent.length + 1,
      created_at: new Date().toISOString(),
      kind: "help",
      contact_id: p.to.id,
      contact_name: p.to.name,
      body: p.body,
      status: "delivered",
      simulated: true,
    });
    return { status: "delivered", simulated: true, error: null, to: p.to };
  }

  async cancel(ticket: string): Promise<void> {
    this.tickets.delete(ticket);
  }

  async messages(): Promise<SentMessage[]> {
    return [...this.sent];
  }
}

let practice: PracticeCarer | null = null;

export function carerSource(): CarerSource {
  if (!practiceMode()) return coordinatorCarer;
  practice ??= new PracticeCarer();
  return practice;
}
