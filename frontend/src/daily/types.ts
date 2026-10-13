/** My day's data, as the coordinator stores it (backend/agency/daily/models.py) and the practice day mirrors it. */

export type ItemKind = "appointment" | "visit" | "care" | "reminder";
export type RoutineKind = "reposition" | "eye_drops" | "mouth_care" | "water" | "other";
export type RequestKind = "help" | "routine" | "schedule";

export interface ScheduleItem {
  id: string;
  kind: ItemKind;
  title: string;
  /** Local wall-clock time, "14:30". */
  time: string;
  /** One day ("2026-10-12"), or null for a repeating item. */
  date: string | null;
  /** Repeat days, 0 = Monday ... 6 = Sunday. Empty with no date: every day. */
  days: number[];
  note: string;
  set_by: "person" | "carer";
  /** Read from the Mac's Calendar for today only; never saved. */
  fromCalendar?: boolean;
}

export interface Routine {
  id: string;
  kind: RoutineKind;
  title: string;
  every_min: number;
  /** Only ask between these local times. */
  start: string;
  end: string;
  enabled: boolean;
}

export interface RoutineState {
  last_done_at: string | null;
  snoozed_until: string | null;
}

export interface Mark {
  status: "done" | "later";
  /** For "later": local "HH:MM" to show it again. */
  until: string | null;
  at: string;
}

export interface DailySettings {
  carer_notify: boolean;
  carer_id: string | null;
  speak_prompts: boolean;
}

export interface CarerOption {
  id: string;
  name: string;
  role: string;
  channel: string;
  simulated: boolean;
  reachable: boolean;
}

/** Who a request would reach now, or null when telling a carer is off. */
export interface CarerView {
  id: string;
  name: string;
  role: string;
  simulated: boolean;
  /** How, in words: "a simulated phone (practice: nobody real is contacted)". */
  how: string;
}

export interface RequestView {
  id: string;
  kind: RequestKind;
  text: string;
  created_at: string;
  /** "shown" (nobody was told), "sending", "delivered" (simulated phone), "sent" (real text accepted), "failed". */
  status: string;
  simulated: boolean;
  carer: { id: string; name: string } | null;
  error: string | null;
  reply: "coming" | "soon" | "cant" | null;
  reply_words: string | null;
  replied_at: string | null;
  duplicate?: boolean;
}

export interface DailyState {
  settings: DailySettings;
  items: ScheduleItem[];
  routines: Routine[];
  routine_state: Record<string, RoutineState>;
  marks: Record<string, Mark>;
  carers: CarerOption[];
  carer: CarerView | null;
  requests: RequestView[];
}

export interface MarkBody {
  item_id: string;
  day: string;
  status: "done" | "later" | "clear";
  until?: string;
}
