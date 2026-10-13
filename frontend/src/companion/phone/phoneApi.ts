/**
 * The phone's side: it talks only to the phone server (`/phone/api`, same origin), with its own device key in an
 * Authorization header. The key lives in this phone's browser storage; removing the phone on the Mac makes it
 * useless at once.
 */

const TOKEN_KEY = "agency.companion.token";

export function deviceToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setDeviceToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing: the pairing lasts for this page only */
  }
}

export class PhoneError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Called when the phone has been removed (or was never paired), so the app goes back to pairing. */
let onUnpaired: () => void = () => undefined;
export function whenUnpaired(fn: () => void): void {
  onUnpaired = fn;
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = deviceToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(`/phone/api${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.method && init.method !== "GET" ? JSON.stringify(init.body ?? {}) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new PhoneError("Can't reach AGENCY. Is this phone on the same Wi-Fi as the Mac?", 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `Something went wrong (${res.status}).`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail)) {
        const first = body.detail[0] as { msg?: unknown } | undefined;
        if (first && typeof first.msg === "string") detail = first.msg.replace(/^Value error, /, "");
      }
    } catch {
      try {
        detail = (await res.text()) || detail;
      } catch {
        /* keep the plain message */
      }
    }
    if (res.status === 401 && path !== "/pair") {
      setDeviceToken(null);
      onUnpaired();
    }
    throw new PhoneError(detail, res.status);
  }
  return (await res.json()) as T;
}

export type ContactRole = "caregiver" | "family" | "neighbour" | "clinician" | "monitoring_service" | "other";
export type Channel = "demo" | "sms" | "sms_call";

export interface Contact {
  id: string;
  name: string;
  role: ContactRole;
  channel: Channel;
  address: string;
  priority: number;
  enabled: boolean;
}

export interface Device {
  id: string;
  name: string;
  contact_id: string | null;
  contact_name: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface Safety {
  watch: boolean;
  checkin_interval_min: number;
  alert_on_signal_unavailable: boolean;
  ack_timeout_s: number;
  watchdog_timeout_s: number;
}

export type Details = Record<
  | "fullName"
  | "preferredName"
  | "dateOfBirth"
  | "phone"
  | "email"
  | "line1"
  | "line2"
  | "city"
  | "region"
  | "postalCode",
  string
>;

export interface Change {
  id: number;
  author: string;
  kind: string;
  summary: string;
  status: "applied" | "waiting_person" | "waiting_mac" | "declined" | "failed" | "replaced" | "unchanged";
  reason: string | null;
  created_at: string;
}

export interface Setup {
  contacts: Contact[];
  safety: Safety;
  mac: {
    known: boolean;
    at: string | null;
    phrases: string[];
    favourites: { title: string; url: string }[];
    papers_folder: { display: string } | null;
    details: Details | null;
  };
  open: Change[];
}

export interface AlertView {
  id: string;
  status: "pending_cancel" | "active" | "acknowledged";
  is_test: boolean;
  what: string;
  situation_label: string | null;
  urgency: string | null;
  acknowledged_by: string | null;
  respond_path: string | null;
  contacted: { name: string; status: string; response: string | null }[];
}

export interface Home {
  server_time: string;
  device: Device;
  person: string;
  running: boolean;
  last_heard_at: string | null;
  camera: { state: string | null; ok: boolean; face_visible: boolean | null; eye_signal: boolean | null };
  battery: { level: number | null; charging: boolean | null; known: boolean };
  watch: {
    armed: boolean;
    next_checkin_at: string | null;
    checkin_pending_since: string | null;
    checkin_last_ok_at: string | null;
  };
  alert: AlertView | null;
  recent_alerts: {
    id: string;
    what: string;
    status: string;
    is_test: boolean;
    created_at: string;
    acknowledged_by: string | null;
    resolved_by: string | null;
  }[];
  waiting_for_person: number;
  lifeline_problems: string[];
}

export interface Note {
  id: number;
  author: string;
  text: string;
  created_at: string;
}

export interface SentMessage {
  id: number;
  text: string;
  has_photo: boolean;
  created_at: string;
  seen_at: string | null;
}

export const phoneApi = {
  pair: (code: string, name: string) =>
    call<{ token: string; device: Device }>("/pair", { method: "POST", body: { code, name } }),
  me: () => call<Device>("/me"),
  link: (contact_id: string | null) => call<Device>("/me/link", { method: "POST", body: { contact_id } }),
  forget: () => call<{ ok: boolean }>("/me/forget", { method: "POST" }),
  home: () => call<Home>("/home", { timeoutMs: 8000 }),
  setup: () => call<Setup>("/setup"),
  change: (kind: string, body: unknown) => call<Change>(`/setup/${kind}`, { method: "PUT", body }),
  notes: () => call<Note[]>("/notes"),
  addNote: (text: string) => call<Note>("/notes", { method: "POST", body: { text } }),
  messages: () => call<SentMessage[]>("/messages"),
  send: (text: string, photo: string | null) =>
    call<SentMessage>("/messages", { method: "POST", body: { text, photo }, timeoutMs: 30_000 }),
};

/** "10:42" today, otherwise "Tue 10:42". */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** A pairing link carries the code after #pair= (never sent to the server in the address). */
export function codeFromHash(hash: string): string | null {
  const m = /(?:^#|&)pair=(\d{6})(?:&|$)/.exec(hash);
  return m ? m[1]! : null;
}

/** A Lifeline contact id from a name: lowercase letters, digits and _ only, unique enough for one home. */
export function contactId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30) || "person";
  let id = base.length >= 2 ? base : `${base}_p`;
  let n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
}

/** Shrink a photo on the phone before sending: at most `max` px on the long side, JPEG. */
export async function shrinkPhoto(file: File, max = 1280, quality = 0.8): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That photo couldn't be opened."));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("That photo couldn't be prepared.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Move to another place in the companion ("setup/contacts"). */
export function go(path: string): void {
  window.location.hash = `#/${path}`;
}
