/**
 * Where My day's data lives: on the coordinator (backend/agency/daily), or, in practice, only in this browser.
 *
 * Practice is used in the web demo, in tests that ask for it (`agency.fakes` includes "daily"), and after someone
 * chooses "Try a practice day" on an empty My day. Practice is always labelled: its carers are practice phones, and
 * nothing leaves the page.
 */
import { accessToken, coordinatorUrl } from "../api/client";
import { fakeForced } from "../state/host";
import { dayKey, hhmmOf } from "./day";
import type {
  DailySettings,
  DailyState,
  MarkBody,
  RequestKind,
  RequestView,
  Routine,
  RoutineState,
  ScheduleItem,
} from "./types";

export interface DailySource {
  kind: "coordinator" | "practice";
  state(day: string): Promise<DailyState>;
  saveSettings(s: DailySettings): Promise<DailySettings>;
  saveItems(items: ScheduleItem[]): Promise<ScheduleItem[]>;
  saveRoutines(routines: Routine[]): Promise<Routine[]>;
  mark(body: MarkBody): Promise<void>;
  routineDone(id: string): Promise<void>;
  routineLater(id: string, minutes: number): Promise<void>;
  request(kind: RequestKind, text: string): Promise<RequestView>;
  requests(): Promise<RequestView[]>;
}

export const PRACTICE_KEY = "agency.daily.practice";
const PRACTICE_DATA_KEY = "agency.daily.practiceData";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: practice lasts for this page only */
  }
}

export function practiceChosen(): boolean {
  return import.meta.env.VITE_WEB_DEMO === "1" || fakeForced("daily") || read(PRACTICE_KEY) === "1";
}

/** Switch this browser to (or away from) the practice day. Leaving practice forgets the practice data. */
export function setPractice(on: boolean): void {
  write(PRACTICE_KEY, on ? "1" : null);
  if (!on) write(PRACTICE_DATA_KEY, null);
  shared = null;
}

// ---- the coordinator ---------------------------------------------------------------------------------------------

export class DailyError extends Error {}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const token = accessToken();
  if (token) headers.set("X-Agency-Token", token);
  let r: Response;
  try {
    r = await fetch(`${coordinatorUrl()}${path}`, { ...init, headers });
  } catch {
    throw new DailyError("AGENCY can't reach the coordinator right now. Nothing was changed.");
  }
  if (!r.ok) {
    let detail = `The coordinator said no (${r.status}).`;
    try {
      const body = (await r.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail))
        detail = "Something in that isn't filled in right. Check it and try again.";
    } catch {
      /* not JSON */
    }
    throw new DailyError(detail);
  }
  return (await r.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

class CoordinatorDaily implements DailySource {
  kind = "coordinator" as const;
  state(day: string) {
    return call<DailyState>(`/api/daily?day=${encodeURIComponent(day)}`);
  }
  saveSettings(s: DailySettings) {
    return call<DailySettings>("/api/daily/settings", json("PUT", s));
  }
  async saveItems(items: ScheduleItem[]) {
    const clean = items.filter((i) => !i.fromCalendar).map(({ fromCalendar: _f, ...i }) => i);
    return (await call<{ items: ScheduleItem[] }>("/api/daily/items", json("PUT", { items: clean }))).items;
  }
  async saveRoutines(routines: Routine[]) {
    return (await call<{ routines: Routine[] }>("/api/daily/routines", json("PUT", { routines }))).routines;
  }
  async mark(body: MarkBody) {
    await call("/api/daily/marks", json("POST", body));
  }
  async routineDone(id: string) {
    await call(`/api/daily/routines/${encodeURIComponent(id)}/done`, json("POST"));
  }
  async routineLater(id: string, minutes: number) {
    await call(`/api/daily/routines/${encodeURIComponent(id)}/later`, json("POST", { minutes }));
  }
  request(kind: RequestKind, text: string) {
    return call<RequestView>("/api/daily/requests", json("POST", { kind, text }));
  }
  requests() {
    return call<RequestView[]>("/api/daily/requests?limit=10");
  }
}

// ---- practice ----------------------------------------------------------------------------------------------------

interface PracticeData {
  settings: DailySettings;
  items: ScheduleItem[];
  routines: Routine[];
  routine_state: Record<string, RoutineState>;
  marks: Record<string, Record<string, { status: "done" | "later"; until: string | null; at: string }>>;
  requests: RequestView[];
}

const PRACTICE_CARERS = [
  { id: "jordan", name: "Jordan", role: "caregiver", channel: "demo", simulated: true, reachable: true },
  { id: "morgan", name: "Morgan", role: "neighbour", channel: "demo", simulated: true, reachable: true },
];

/** How long the practice carer takes to answer, so the person sees the answer arrive. */
export const PRACTICE_REPLY_MS = 4000;

function roundUp(now: Date, minutes: number): string {
  // Late in the evening, plan from 7:30 pm so the practice plans stay apart and on today.
  const late = new Date(now);
  late.setHours(19, 30, 0, 0);
  const base = now > late ? late : now;
  const d = new Date(base.getTime() + minutes * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return hhmmOf(d);
}

/** A practice day built around now, so there is always something next. Fictional, and labelled practice. */
export function practiceDay(now: Date): PracticeData {
  const day = dayKey(now);
  const items: ScheduleItem[] = [
    {
      id: "eye-drops-am",
      kind: "care",
      title: "Eye drops",
      time: "08:30",
      date: null,
      days: [],
      note: "",
      set_by: "carer",
    },
    {
      id: "physio",
      kind: "visit",
      title: "Physio visit",
      time: roundUp(now, 60),
      date: day,
      days: [],
      note: "with Sam, the physiotherapist",
      set_by: "carer",
    },
    {
      id: "clinic",
      kind: "appointment",
      title: "Video call with the clinic",
      time: roundUp(now, 150),
      date: day,
      days: [],
      note: "Dr. Patel's office",
      set_by: "carer",
    },
    {
      id: "mom-call",
      kind: "reminder",
      title: "Call Mom",
      time: roundUp(now, 240),
      date: day,
      days: [],
      note: "",
      set_by: "person",
    },
  ];
  const routines: Routine[] = [
    {
      id: "water",
      kind: "water",
      title: "Drink some water",
      every_min: 90,
      start: "00:00",
      end: "23:59",
      enabled: true,
    },
    {
      id: "reposition",
      kind: "reposition",
      title: "Change position",
      every_min: 120,
      start: "00:00",
      end: "23:59",
      enabled: true,
    },
    {
      id: "mouth",
      kind: "mouth_care",
      title: "Mouth care",
      every_min: 240,
      start: "08:00",
      end: "21:00",
      enabled: true,
    },
  ];
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return {
    settings: { carer_notify: true, carer_id: "jordan", speak_prompts: false },
    items,
    routines,
    // Water is due now; the others were done recently.
    routine_state: {
      water: { last_done_at: ago(100), snoozed_until: null },
      reposition: { last_done_at: ago(30), snoozed_until: null },
      mouth: { last_done_at: ago(60), snoozed_until: null },
    },
    marks: { [day]: { "eye-drops-am": { status: "done", until: null, at: ago(120) } } },
    requests: [],
  };
}

export class PracticeDaily implements DailySource {
  kind = "practice" as const;
  private data: PracticeData;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly persist = true,
  ) {
    const saved = persist ? read(PRACTICE_DATA_KEY) : null;
    let data: PracticeData | null = null;
    if (saved) {
      try {
        data = JSON.parse(saved) as PracticeData;
      } catch {
        data = null;
      }
    }
    this.data = data ?? practiceDay(now());
    this.save();
  }

  private save(): void {
    if (this.persist) write(PRACTICE_DATA_KEY, JSON.stringify(this.data));
  }

  private carer() {
    const s = this.data.settings;
    const c = s.carer_notify ? PRACTICE_CARERS.find((x) => x.id === s.carer_id) : undefined;
    return c
      ? {
          id: c.id,
          name: c.name,
          role: c.role,
          simulated: true,
          how: "a practice phone (nobody real is contacted)",
        }
      : null;
  }

  async state(day: string): Promise<DailyState> {
    const d = structuredClone(this.data);
    return {
      settings: d.settings,
      items: d.items,
      routines: d.routines,
      routine_state: d.routine_state,
      marks: d.marks[day] ?? {},
      carers: PRACTICE_CARERS,
      carer: this.carer(),
      requests: d.requests.slice(0, 10),
    };
  }
  async saveSettings(s: DailySettings) {
    this.data.settings = { ...s };
    this.save();
    return s;
  }
  async saveItems(items: ScheduleItem[]) {
    this.data.items = items.filter((i) => !i.fromCalendar);
    this.save();
    return this.data.items;
  }
  async saveRoutines(routines: Routine[]) {
    this.data.routines = routines;
    this.save();
    return routines;
  }
  async mark(body: MarkBody) {
    const day = (this.data.marks[body.day] ??= {});
    if (body.status === "clear") delete day[body.item_id];
    else day[body.item_id] = { status: body.status, until: body.until ?? null, at: this.now().toISOString() };
    this.save();
  }
  async routineDone(id: string) {
    this.data.routine_state[id] = { last_done_at: this.now().toISOString(), snoozed_until: null };
    this.save();
  }
  async routineLater(id: string, minutes: number) {
    const last = this.data.routine_state[id]?.last_done_at ?? null;
    const until = new Date(this.now().getTime() + minutes * 60_000).toISOString();
    this.data.routine_state[id] = { last_done_at: last, snoozed_until: until };
    this.save();
  }
  async request(kind: RequestKind, text: string): Promise<RequestView> {
    const carer = this.carer();
    const r: RequestView = {
      id: `req_${Math.random().toString(16).slice(2, 12)}`,
      kind,
      text: text.trim().slice(0, 160),
      created_at: this.now().toISOString(),
      status: carer ? "delivered" : "shown",
      simulated: true,
      carer: carer ? { id: carer.id, name: carer.name } : null,
      error: null,
      reply: null,
      reply_words: null,
      replied_at: null,
    };
    this.data.requests.unshift(r);
    this.data.requests = this.data.requests.slice(0, 20);
    this.save();
    if (carer) {
      // The practice carer answers by themselves, so the whole path can be seen.
      const t = setTimeout(() => {
        this.timers.delete(t);
        const found = this.data.requests.find((x) => x.id === r.id);
        if (!found) return;
        found.reply = "coming";
        found.reply_words = "On my way";
        found.replied_at = this.now().toISOString();
        this.save();
      }, PRACTICE_REPLY_MS);
      this.timers.add(t);
    }
    return { ...r };
  }
  async requests() {
    return structuredClone(this.data.requests.slice(0, 10));
  }
}

let shared: DailySource | null = null;

export function dailySource(): DailySource {
  if (!shared) shared = practiceChosen() ? new PracticeDaily() : new CoordinatorDaily();
  return shared;
}

/** Tests only. */
export function setDailySourceForTests(source: DailySource | null): void {
  shared = source;
}
