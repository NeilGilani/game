/**
 * The day's rules, as plain functions of the data and the time: what is on today and in what order, which care
 * routines are due, and the words read aloud. Times are the person's local wall-clock times.
 *
 * Routines ask, they don't tell: a routine is "due" only inside its waking hours, at most once per interval since it
 * was last done, and never while the person has put it off. Nothing here is a clinical alarm.
 */
import type { Mark, Routine, RoutineState, ScheduleItem } from "./types";

export type AgendaStatus = "done" | "later" | "earlier" | "next" | "upcoming";

export interface AgendaEntry {
  item: ScheduleItem;
  status: AgendaStatus;
  /** The time it shows at: the "later" time when put off, otherwise its own time. */
  at: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date, "2026-10-12". */
export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "14:30" -> 870. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local "HH:MM" for a time. */
export function hhmmOf(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "15:00" -> "3:00 pm", "00:30" -> "12:30 am". */
export function formatTime(hhmm: string): string {
  const m = minutesOf(hhmm);
  const h = Math.floor(m / 60);
  const suffix = h < 12 ? "am" : "pm";
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m % 60)} ${suffix}`;
}

export function formatClock(d: Date): string {
  return formatTime(hhmmOf(d));
}

/** Monday is 0, as the coordinator counts. */
export function weekday(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export function occursOn(item: ScheduleItem, d: Date): boolean {
  if (item.date) return item.date === dayKey(d);
  return item.days.length === 0 || item.days.includes(weekday(d));
}

/** The time `minutes` from now as local "HH:MM", capped at the end of the day. */
export function laterTime(now: Date, minutes: number): string {
  const t = Math.min(now.getHours() * 60 + now.getMinutes() + minutes, 23 * 60 + 59);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** Today's items in order, each with what it means now. Exactly one "next" while anything is still to come. */
export function agenda(items: ScheduleItem[], marks: Record<string, Mark>, now: Date): AgendaEntry[] {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = items
    .filter((i) => occursOn(i, now))
    .map((item) => {
      const mark = marks[item.id];
      if (mark?.status === "done") return { item, status: "done" as AgendaStatus, at: item.time };
      if (mark?.status === "later" && mark.until && minutesOf(mark.until) > nowMin)
        return { item, status: "later" as AgendaStatus, at: mark.until };
      const at = mark?.status === "later" && mark.until ? mark.until : item.time;
      return { item, status: (minutesOf(at) < nowMin ? "earlier" : "upcoming") as AgendaStatus, at };
    })
    .sort((a, b) => minutesOf(a.at) - minutesOf(b.at) || a.item.title.localeCompare(b.item.title));
  const next = today.find((e) => e.status === "upcoming");
  if (next) next.status = "next";
  return today;
}

function inWindow(r: Routine, minute: number): boolean {
  const s = minutesOf(r.start);
  const e = minutesOf(r.end);
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}

/** When the window that contains `now` began (or, outside it, when the next one begins). */
function windowStart(r: Routine, now: Date): Date {
  const s = minutesOf(r.start);
  const d = new Date(now);
  d.setHours(Math.floor(s / 60), s % 60, 0, 0);
  const minute = now.getHours() * 60 + now.getMinutes();
  if (inWindow(r, minute)) {
    if (d > now) d.setDate(d.getDate() - 1); // an overnight window that began yesterday
  } else if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

/** When the routine should next ask. */
export function nextDue(r: Routine, state: RoutineState | undefined, now: Date): Date {
  const start = windowStart(r, now);
  const last = state?.last_done_at ? new Date(state.last_done_at) : null;
  let due = last ? new Date(last.getTime() + r.every_min * 60_000) : start;
  if (due < start) due = start;
  const snooze = state?.snoozed_until ? new Date(state.snoozed_until) : null;
  if (snooze && snooze > due) due = snooze;
  // Past the end of waking hours: the next window.
  if (!inWindow(r, due.getHours() * 60 + due.getMinutes()) && due > now) {
    const next = windowStart(r, due);
    if (next > due) due = next;
  }
  return due;
}

export function isDue(r: Routine, state: RoutineState | undefined, now: Date): boolean {
  if (!r.enabled) return false;
  if (!inWindow(r, now.getHours() * 60 + now.getMinutes())) return false;
  return nextDue(r, state, now).getTime() <= now.getTime();
}

export function dueRoutines(routines: Routine[], states: Record<string, RoutineState>, now: Date): Routine[] {
  return routines.filter((r) => isDue(r, states[r.id], now));
}

const VERBS = new Set(
  "drink change stretch take do have check move turn brush wash eat rest sit lie use put clean rinse moisten".split(
    " ",
  ),
);

/** A gentle question for a due routine: "Time to drink some water?", "Time for eye drops?" */
export function routinePrompt(r: Routine): string {
  const t = r.title.trim().replace(/[.!?]+$/, "");
  const lower = `${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  const first = lower.split(/\s+/)[0] ?? "";
  return `Time ${VERBS.has(first) ? "to" : "for"} ${lower}?`;
}

/** "every 2 hours", "every 90 minutes". */
export function everyText(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** What "Read my day" says. Plain sentences, the next thing first. */
export function daySummary(entries: AgendaEntry[], due: Routine[], now: Date): string {
  const parts = [`It's ${WEEKDAYS[weekday(now)]}, ${formatClock(now)}.`];
  if (due.length) parts.push(`${due.map(routinePrompt).join(" ")}`);
  const next = entries.find((e) => e.status === "next");
  const describe = (e: AgendaEntry) =>
    `${e.item.title} at ${formatTime(e.at)}${e.item.note ? `, ${e.item.note.replace(/[.!?]+$/, "")}` : ""}`;
  if (next) parts.push(`Next: ${describe(next)}.`);
  const after = entries.filter((e) => e.status === "upcoming").slice(0, 3);
  if (after.length) parts.push(`Then: ${after.map(describe).join("; ")}.`);
  const later = entries.filter((e) => e.status === "later");
  if (later.length) parts.push(`Put off until later: ${later.map(describe).join("; ")}.`);
  const done = entries.filter((e) => e.status === "done").length;
  if (!entries.length) parts.push("Nothing is planned for today.");
  else if (!next && !after.length && !later.length) parts.push("Nothing more is planned for today.");
  if (done) parts.push(done === 1 ? "One thing is done." : `${done} things are done.`);
  return parts.join(" ");
}

export const KIND_LABEL: Record<ScheduleItem["kind"], string> = {
  appointment: "Appointment",
  visit: "Visit",
  care: "Care",
  reminder: "Reminder",
};
