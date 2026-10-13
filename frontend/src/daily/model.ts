/**
 * My day and care routines: plain data and pure functions (no React, no storage), so they can be tested.
 *
 * - Day items are appointments, visits, care and reminders, set by the person or a helper. Each has a date, an
 *   optional time and how it repeats. The person marks each day's copy done or "later".
 * - Care routines ask, they don't tell: "time to change position" every few hours within waking hours, snoozed
 *   whenever the person likes. They are reminders the person or their care team set up, not medication dosing
 *   advice and not clinical alarms. Nothing here escalates or tells anyone on its own.
 *
 * All times are the computer's local time. `now` is always passed in.
 */

export type ItemKind = "appointment" | "visit" | "care" | "reminder";
export type Repeat = "once" | "daily" | "weekdays" | "weekly";

export interface DayItem {
  id: string;
  title: string;
  kind: ItemKind;
  /** The first (or only) day, "YYYY-MM-DD". */
  date: string;
  /** "HH:MM", or null for any time that day. */
  time: string | null;
  repeat: Repeat;
  addedBy: "person" | "helper";
}

/** The person's mark on one day's copy of an item, keyed by `markKey(id, date)`. */
export interface Mark {
  status: "done" | "later";
  at: number;
  /** "Later": when it comes back. */
  until?: number;
}

export type RoutineKind = "reposition" | "eye_drops" | "mouth_care" | "water" | "custom";

export interface Routine {
  id: string;
  kind: RoutineKind;
  /** What the prompt says: "Change position". */
  label: string;
  everyMinutes: number;
  /** Waking hours: prompts only between these times ("HH:MM"). */
  from: string;
  to: string;
  snoozeMinutes: number;
  enabled: boolean;
  lastDone: number | null;
  snoozedUntil: number | null;
}

export interface DailyData {
  items: DayItem[];
  routines: Routine[];
  marks: Record<string, Mark>;
}

export const EMPTY_DATA: DailyData = { items: [], routines: [], marks: {} };

export const KIND_WORDS: Record<ItemKind, string> = {
  appointment: "Appointment",
  visit: "Visit",
  care: "Care",
  reminder: "Reminder",
};

/** Starting points a helper can adjust. How often is for the person and their care team to decide. */
export const ROUTINE_PRESETS: Record<
  Exclude<RoutineKind, "custom">,
  { label: string; everyMinutes: number }
> = {
  reposition: { label: "Change position", everyMinutes: 120 },
  eye_drops: { label: "Eye drops", everyMinutes: 240 },
  mouth_care: { label: "Mouth care", everyMinutes: 240 },
  water: { label: "A drink of water", everyMinutes: 90 },
};

export const LATER_MINUTES = 30;
export const MAX_ITEMS = 60;
export const MAX_ROUTINES = 12;
export const MAX_TITLE = 60;

// ---------------------------------------------------------------------------------------------------------------
// Dates and times

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" for the local day of `t`. */
export function dayKey(t: number | Date): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Milliseconds at "HH:MM" on the local day of `day`. */
export function at(day: number, hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function parseDay(key: string): Date {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function validTime(hhmm: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm);
}

export function validDay(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && dayKey(parseDay(key)) === key;
}

/** "2:00 pm" from "14:00" (no locale surprises, read the same aloud everywhere). */
export function clock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

/** "2:00 pm" for a timestamp. */
export function clockAt(t: number): string {
  const d = new Date(t);
  return clock(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Monday 12 October". */
export function longDay(t: number): string {
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "every 2 hours", "every 90 minutes". */
export function every(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

// ---------------------------------------------------------------------------------------------------------------
// My day

export function markKey(id: string, day: string): string {
  return `${id}@${day}`;
}

/** Does this item happen on this day? */
export function occursOn(item: DayItem, day: string): boolean {
  if (day < item.date) return false;
  if (item.repeat === "once") return day === item.date;
  if (item.repeat === "daily") return true;
  const wd = parseDay(day).getDay();
  if (item.repeat === "weekdays") return wd >= 1 && wd <= 5;
  return wd === parseDay(item.date).getDay();
}

export type EntryState = "open" | "done" | "later";

export interface DayEntry {
  item: DayItem;
  day: string;
  state: EntryState;
  /** When a "later" comes back. */
  until?: number;
}

/** One day's items in time order (any-time items last), each with the person's mark. */
export function entriesFor(data: DailyData, day: string, now: number): DayEntry[] {
  return data.items
    .filter((i) => occursOn(i, day))
    .sort((a, b) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99") || a.title.localeCompare(b.title))
    .map((item) => {
      const mark = data.marks[markKey(item.id, day)];
      if (mark?.status === "done") return { item, day, state: "done" as const };
      if (mark?.status === "later" && (mark.until ?? 0) > now)
        return { item, day, state: "later" as const, until: mark.until };
      return { item, day, state: "open" as const };
    });
}

export function mark(data: DailyData, entry: DayEntry, status: Mark["status"], now: number): DailyData {
  const value: Mark =
    status === "later" ? { status, at: now, until: now + LATER_MINUTES * 60_000 } : { status, at: now };
  const marks = { ...data.marks, [markKey(entry.item.id, entry.day)]: value };
  return { ...data, marks: pruneMarks(marks, now) };
}

export function unmark(data: DailyData, entry: DayEntry): DailyData {
  const marks = { ...data.marks };
  delete marks[markKey(entry.item.id, entry.day)];
  return { ...data, marks };
}

/** Marks older than two weeks are forgotten. */
export function pruneMarks(marks: Record<string, Mark>, now: number): Record<string, Mark> {
  const cutoff = now - 14 * 86_400_000;
  return Object.fromEntries(Object.entries(marks).filter(([, m]) => m.at >= cutoff));
}

// ---------------------------------------------------------------------------------------------------------------
// Care routines

/** Waking hours on the day of `t`. A "to" at or before "from" means until midnight. */
function windowOn(r: Routine, t: number): { start: number; end: number } {
  const start = at(t, r.from);
  let end = at(t, r.to);
  if (end <= start) end = at(t, "23:59") + 60_000;
  return { start, end };
}

/** When the routine next asks, or null when it is switched off. */
export function nextDue(r: Routine, now: number): number | null {
  if (!r.enabled || r.everyMinutes <= 0) return null;
  const today = windowOn(r, now);
  let due = r.lastDone === null ? today.start : r.lastDone + r.everyMinutes * 60_000;
  if (r.snoozedUntil !== null && r.snoozedUntil > due) due = r.snoozedUntil;
  if (due < today.start) due = today.start;
  // Missed today's waking hours (or due after them): tomorrow morning.
  if (due >= today.end || now >= today.end) due = Math.max(windowOn(r, today.start + 86_400_000).start, due);
  return due;
}

export function isDue(r: Routine, now: number): boolean {
  const due = nextDue(r, now);
  return due !== null && due <= now;
}

export function dueRoutines(data: DailyData, now: number): Routine[] {
  return data.routines.filter((r) => isDue(r, now));
}

function updateRoutine(data: DailyData, id: string, change: Partial<Routine>): DailyData {
  return { ...data, routines: data.routines.map((r) => (r.id === id ? { ...r, ...change } : r)) };
}

export function routineDone(data: DailyData, id: string, now: number): DailyData {
  return updateRoutine(data, id, { lastDone: now, snoozedUntil: null });
}

export function routineLater(data: DailyData, id: string, now: number): DailyData {
  const r = data.routines.find((x) => x.id === id);
  return updateRoutine(data, id, { snoozedUntil: now + (r?.snoozeMinutes ?? LATER_MINUTES) * 60_000 });
}

export function newRoutine(kind: RoutineKind, id: string, label?: string): Routine {
  const preset =
    kind === "custom" ? { label: label ?? "Reminder", everyMinutes: 120 } : ROUTINE_PRESETS[kind];
  return {
    id,
    kind,
    label: label ?? preset.label,
    everyMinutes: preset.everyMinutes,
    from: "08:00",
    to: "22:00",
    snoozeMinutes: LATER_MINUTES,
    enabled: true,
    lastDone: null,
    snoozedUntil: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What's next, and the day read aloud

export type NextUp =
  { type: "routine"; routine: Routine } | { type: "item"; entry: DayEntry } | { type: "nothing" };

/** For Home: a routine asking now, else the next open item today (from half an hour ago on), else nothing. */
export function nextUp(data: DailyData, now: number): NextUp {
  const due = dueRoutines(data, now)[0];
  if (due) return { type: "routine", routine: due };
  const today = dayKey(now);
  const soon = now - 30 * 60_000;
  const entry = entriesFor(data, today, now).find(
    (e) => e.state === "open" && (e.item.time === null || at(now, e.item.time) >= soon),
  );
  return entry ? { type: "item", entry } : { type: "nothing" };
}

export function entryWhen(e: DayEntry): string {
  return e.item.time ? clock(e.item.time) : "Any time";
}

/** The day in plain sentences, for reading aloud. */
export function daySpeech(data: DailyData, now: number): string {
  const entries = entriesFor(data, dayKey(now), now);
  const parts = [`Today is ${longDay(now)}.`];
  const open = entries.filter((e) => e.state !== "done");
  if (open.length === 0)
    parts.push(entries.length ? "Everything on today's list is done." : "Nothing is planned today.");
  for (const e of open)
    parts.push(`${e.item.time ? `At ${clock(e.item.time)}` : "Any time"}: ${e.item.title}.`);
  const done = entries.length - open.length;
  if (done && open.length) parts.push(`${done} done already.`);
  for (const r of data.routines.filter((x) => x.enabled)) {
    const due = nextDue(r, now);
    if (due === null) continue;
    parts.push(due <= now ? `${r.label}: now, when you're ready.` : `${r.label}: next at ${clockAt(due)}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------------------------
// Checking what comes from storage or a helper's form

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // Control characters become spaces (a character test, so the linter's control-character rule is kept).
  const t = Array.from(v, (c) => (c < " " || c === "\u007f" ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return t && t.length <= max ? t : null;
}

const ITEM_KINDS: ItemKind[] = ["appointment", "visit", "care", "reminder"];
const REPEATS: Repeat[] = ["once", "daily", "weekdays", "weekly"];
const ROUTINE_KINDS: RoutineKind[] = ["reposition", "eye_drops", "mouth_care", "water", "custom"];

export function checkItem(raw: unknown): DayItem | null {
  const r = raw as Partial<DayItem> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) return null;
  const title = str(r.title, MAX_TITLE);
  if (!title || !ITEM_KINDS.includes(r.kind as ItemKind) || !REPEATS.includes(r.repeat as Repeat))
    return null;
  if (typeof r.date !== "string" || !validDay(r.date)) return null;
  if (r.time !== null && (typeof r.time !== "string" || !validTime(r.time))) return null;
  return {
    id: r.id.slice(0, 40),
    title,
    kind: r.kind as ItemKind,
    date: r.date,
    time: r.time,
    repeat: r.repeat as Repeat,
    addedBy: r.addedBy === "person" ? "person" : "helper",
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function checkRoutine(raw: unknown): Routine | null {
  const r = raw as Partial<Routine> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) return null;
  const label = str(r.label, MAX_TITLE);
  const everyMinutes = num(r.everyMinutes);
  const snoozeMinutes = num(r.snoozeMinutes);
  if (!label || !ROUTINE_KINDS.includes(r.kind as RoutineKind)) return null;
  if (everyMinutes === null || everyMinutes < 15 || everyMinutes > 24 * 60) return null;
  if (snoozeMinutes === null || snoozeMinutes < 5 || snoozeMinutes > 240) return null;
  if (typeof r.from !== "string" || !validTime(r.from) || typeof r.to !== "string" || !validTime(r.to))
    return null;
  return {
    id: r.id.slice(0, 40),
    kind: r.kind as RoutineKind,
    label,
    everyMinutes: Math.round(everyMinutes),
    from: r.from,
    to: r.to,
    snoozeMinutes: Math.round(snoozeMinutes),
    enabled: r.enabled !== false,
    lastDone: num(r.lastDone),
    snoozedUntil: num(r.snoozedUntil),
  };
}

/** Whatever was stored, made safe: bad entries are dropped, never trusted. */
export function checkData(raw: unknown): DailyData {
  const r = raw as Partial<DailyData> | null;
  if (!r || typeof r !== "object") return structuredClone(EMPTY_DATA);
  const items = (Array.isArray(r.items) ? r.items : []).map(checkItem).filter((x): x is DayItem => !!x);
  const routines = (Array.isArray(r.routines) ? r.routines : [])
    .map(checkRoutine)
    .filter((x): x is Routine => !!x);
  const marks: Record<string, Mark> = {};
  if (r.marks && typeof r.marks === "object") {
    for (const [k, m] of Object.entries(r.marks as Record<string, Partial<Mark>>)) {
      if (!m || (m.status !== "done" && m.status !== "later") || num(m.at) === null) continue;
      marks[k] = { status: m.status, at: m.at!, ...(num(m.until) !== null ? { until: m.until } : {}) };
    }
  }
  return { items: items.slice(0, MAX_ITEMS), routines: routines.slice(0, MAX_ROUTINES), marks };
}

// ---------------------------------------------------------------------------------------------------------------
// Practice

/** A sample day for practice mode and the web demo: clearly made up, never presented as a real person's. */
export function sampleDay(now: number): DailyData {
  const today = dayKey(now);
  const item = (
    id: string,
    title: string,
    kind: ItemKind,
    time: string | null,
    repeat: Repeat = "once",
  ): DayItem => ({
    id,
    title,
    kind,
    date: today,
    time,
    repeat,
    addedBy: "helper",
  });
  return {
    items: [
      item("s-wash", "Morning wash with Jordan", "care", "08:30", "daily"),
      item("s-physio", "Physiotherapy visit", "visit", "11:00"),
      item("s-clinic", "Video call with the clinic", "appointment", "14:30"),
      item("s-show", "Favourite quiz show", "reminder", "18:00", "weekdays"),
      item("s-call", "Call Mom", "reminder", null),
    ],
    routines: [
      { ...newRoutine("reposition", "s-turn"), lastDone: now - 100 * 60_000 },
      { ...newRoutine("eye_drops", "s-drops"), lastDone: now - 250 * 60_000 },
      { ...newRoutine("water", "s-water"), lastDone: now - 30 * 60_000 },
    ],
    marks: {},
  };
}
