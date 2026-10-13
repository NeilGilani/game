/**
 * The person's screen talking to the coordinator about caregiver phones (`/api/companion`, behind the coordinator
 * token like the rest of `/api`). Phones never reach these routes: they have their own server (see
 * backend/agency/companion/server.py).
 */
import { accessToken, coordinatorUrl } from "../api/client";

export interface PairedDevice {
  id: string;
  name: string;
  contact_id: string | null;
  contact_name: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export type ChangeStatus = "applied" | "waiting_person" | "waiting_mac" | "declined" | "failed" | "replaced";
export type ChangeKind =
  "contacts" | "details" | "phrases" | "favourites" | "papers_folder" | "safety" | "device";

export interface CompanionChange {
  id: number;
  device_id: string | null;
  author: string;
  kind: ChangeKind;
  summary: string;
  status: ChangeStatus;
  reason: string | null;
  created_at: string;
  settled_at: string | null;
  payload?: Record<string, unknown>;
}

export interface CompanionStatus {
  available: boolean;
  enabled: boolean;
  listening: boolean;
  error: string | null;
  url: string | null;
  secure: boolean;
  pairing: { expires_at: string } | null;
  devices: PairedDevice[];
  waiting_for_person: CompanionChange[];
}

export interface PairingCode {
  code: string;
  expires_at: string;
  ttl_s: number;
  url: string;
  link: string;
}

export interface InboxMessage {
  id: number;
  author: string;
  text: string;
  photo: string | null;
  created_at: string;
}

export interface HandoverNote {
  id: number;
  author: string;
  text: string;
  created_at: string;
}

export interface MacSnapshot {
  phrases: string[];
  favourites: { title: string; url: string }[];
  papers_folder: { display: string; choice?: string | null } | null;
  details: Record<string, string> | null;
}

export class CompanionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const token = accessToken();
  if (token) headers["X-Agency-Token"] = token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${coordinatorUrl()}/api/companion${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch {
    throw new CompanionApiError("Can't reach the coordinator.", 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `Something went wrong (${res.status}).`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new CompanionApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export const companionApi = {
  status: () => call<CompanionStatus>("/status"),
  setEnabled: (enabled: boolean) => call<CompanionStatus>("/enabled", { method: "POST", body: { enabled } }),
  pair: () => call<PairingCode>("/pair", { method: "POST", body: {} }),
  cancelPair: () => call<CompanionStatus>("/pair/cancel", { method: "POST", body: {} }),
  revoke: (id: string) => call<PairedDevice>(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  changes: () => call<CompanionChange[]>("/changes"),
  open: () => call<CompanionChange[]>("/open"),
  decide: (id: number, allow: boolean) =>
    call<CompanionChange>(`/changes/${id}/decision`, { method: "POST", body: { allow } }),
  applied: (id: number, ok: boolean, reason = "") =>
    call<CompanionChange>(`/changes/${id}/applied`, { method: "POST", body: { ok, reason } }),
  snapshot: (snap: MacSnapshot) => call<{ ok: boolean }>("/snapshot", { method: "PUT", body: snap }),
  presence: (battery_level: number | null, charging: boolean | null) =>
    call<{ ok: boolean }>("/presence", { method: "POST", body: { battery_level, charging } }),
  inbox: () => call<InboxMessage[]>("/inbox"),
  seen: (id: number) => call<InboxMessage>(`/messages/${id}/seen`, { method: "POST", body: {} }),
  notes: () => call<HandoverNote[]>("/notes"),
  addNote: (text: string, author: string) =>
    call<HandoverNote>("/notes", { method: "POST", body: { text, author } }),
};

/** "10:42" today, otherwise "Tue 10:42". */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
