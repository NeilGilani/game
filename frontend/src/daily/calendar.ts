/**
 * Today's events from the Mac's Calendar, read through the native helper (`calendar.today`, read-only, EventKit).
 * Off until a helper turns it on in Settings, My day; only in the Mac app. Events are shown in My day and never
 * saved anywhere, so the coordinator never keeps a copy of the person's calendar.
 */
import { host } from "../state/host";
import type { ScheduleItem } from "./types";

const KEY = "agency.daily.calendar";

export interface CalendarEvent {
  title: string;
  /** Local "HH:MM". */
  start: string;
  allDay: boolean;
  location: string;
  calendar: string;
}

export type CalendarResult = { ok: true; events: CalendarEvent[] } | { ok: false; error: string };

type NativeCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function nativeCall(): NativeCall | null {
  const h = host();
  return h ? (h.native.call as unknown as NativeCall) : null;
}

/** Can this be offered here at all (the Mac app)? */
export function calendarAvailable(): boolean {
  return nativeCall() !== null;
}

export function calendarOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function setCalendarOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Ask the helper for today's events. Never throws: problems come back in plain words. */
export async function readCalendar(): Promise<CalendarResult> {
  const call = nativeCall();
  if (!call) return { ok: false, error: "The Mac's Calendar needs the AGENCY Mac app." };
  try {
    const r = (await call("calendar.today", {})) as CalendarResult;
    if (!r || typeof r !== "object" || (r.ok && !Array.isArray(r.events)))
      return { ok: false, error: "The Mac's Calendar gave an answer AGENCY didn't understand." };
    return r;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /may not call|unknown method|not found/i.test(why)
        ? "This version of the AGENCY Mac app can't read the Calendar yet."
        : "AGENCY couldn't read the Mac's Calendar just now.",
    };
  }
}

/** Calendar events as schedule items for today, marked as from the Calendar. */
export function calendarItems(events: CalendarEvent[]): ScheduleItem[] {
  return events.slice(0, 20).map((e, i) => ({
    id: `cal-${i}`,
    kind: "appointment",
    title: e.title.slice(0, 80) || "Event",
    time: e.allDay ? "00:00" : e.start,
    date: null,
    days: [],
    note: [e.allDay ? "All day" : "", e.location].filter(Boolean).join(", ").slice(0, 200),
    set_by: "carer",
    fromCalendar: true,
  }));
}

/** Today's calendar items when turned on, else none. */
export async function todaysCalendar(): Promise<{ items: ScheduleItem[]; error: string | null }> {
  if (!calendarOn() || !calendarAvailable()) return { items: [], error: null };
  const r = await readCalendar();
  return r.ok ? { items: calendarItems(r.events), error: null } : { items: [], error: r.error };
}
