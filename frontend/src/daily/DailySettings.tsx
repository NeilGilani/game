/**
 * Settings, My day (for a helper): who requests go to (off by default), the schedule, care routines, the Mac's
 * Calendar, and the home. Plain forms for a helper with a keyboard and mouse; the person uses My day itself.
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { Toggle } from "../screens/SettingsViews";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { calendarAvailable, calendarOn, readCalendar, setCalendarOn } from "./calendar";
import { dayKey, everyText, formatTime, KIND_LABEL } from "./day";
import { HomeSettingsSection } from "./HomeSettings";
import { dailySource, practiceChosen, setPractice } from "./source";
import type { DailyState, ItemKind, Routine, RoutineKind, ScheduleItem } from "./types";
import "./daily.css";

const ROUTINE_TEMPLATES: { kind: RoutineKind; title: string; every_min: number }[] = [
  { kind: "reposition", title: "Change position", every_min: 120 },
  { kind: "eye_drops", title: "Eye drops", every_min: 240 },
  { kind: "mouth_care", title: "Mouth care", every_min: 240 },
  { kind: "water", title: "Drink some water", every_min: 90 },
];

const EVERY = [30, 60, 90, 120, 180, 240, 360, 480];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function newId(prefix: string, taken: string[]): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

function when(i: ScheduleItem): string {
  if (i.date) return `${i.date}, ${formatTime(i.time)}`;
  if (!i.days.length) return `Every day, ${formatTime(i.time)}`;
  return `${i.days.map((d) => DAYS[d]).join(", ")}, ${formatTime(i.time)}`;
}

type Draft = {
  title: string;
  kind: ItemKind;
  time: string;
  repeat: "once" | "daily" | "days";
  date: string;
  days: number[];
  note: string;
  byPerson: boolean;
};

const EMPTY = (today: string): Draft => ({
  title: "",
  kind: "appointment",
  time: "10:00",
  repeat: "once",
  date: today,
  days: [],
  note: "",
  byPerson: false,
});

export function DailySettings() {
  const announce = useAnnounce();
  const today = dayKey(new Date());
  const [state, setState] = useState<DailyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => EMPTY(today));
  const [custom, setCustom] = useState("");
  const [calendar, setCalendar] = useState(calendarOn());
  const [calendarNote, setCalendarNote] = useState<string | null>(null);

  const load = async () => {
    try {
      setState(await dailySource().state(today));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "My day's settings couldn't load.");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attempt = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setError(null);
      setNote(done);
      announce(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That couldn't be saved.");
    }
  };

  const s = state?.settings;
  const items = state?.items ?? [];
  const routines = state?.routines ?? [];

  const addItem = () => {
    const title = draft.title.trim();
    if (!title) return setError('Give it a name first, like "Physio visit".');
    if (draft.repeat === "days" && !draft.days.length) return setError("Choose at least one day.");
    const item: ScheduleItem = {
      id: newId(
        "item",
        items.map((i) => i.id),
      ),
      kind: draft.kind,
      title: title.slice(0, 80),
      time: draft.time,
      date: draft.repeat === "once" ? draft.date : null,
      days: draft.repeat === "days" ? draft.days : [],
      note: draft.note.trim().slice(0, 200),
      set_by: draft.byPerson ? "person" : "carer",
    };
    void attempt(async () => {
      await dailySource().saveItems([...items, item]);
      setDraft(EMPTY(today));
    }, `Added ${item.title}.`);
  };

  const setRoutines = (next: Routine[], done: string) =>
    void attempt(() => dailySource().saveRoutines(next), done);
  const addRoutine = (kind: RoutineKind, title: string, every_min: number) =>
    setRoutines(
      [
        ...routines,
        {
          id: newId(
            kind.replace("_", "-"),
            routines.map((r) => r.id),
          ),
          kind,
          title,
          every_min,
          start: "08:00",
          end: "21:00",
          enabled: true,
        },
      ],
      `Added ${title}.`,
    );
  const changeRoutine = (id: string, change: Partial<Routine>) =>
    setRoutines(
      routines.map((r) => (r.id === id ? { ...r, ...change } : r)),
      "Saved.",
    );

  return (
    <Page label="My day settings">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings · For a helper</div>
          <h1>My day</h1>
          <p>
            The schedule, gentle care routines, asking a carer for help, and the home.{" "}
            {dailySource().kind === "practice"
              ? "This browser is showing a practice day: changes here stay on this screen."
              : "Kept on the AGENCY coordinator."}
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/settings/helper")} data-dwell>
          <Icon name="back" /> Back
        </button>
      </div>

      {error && (
        <p className="papers-error" role="alert">
          {error}
        </p>
      )}
      {note && !error && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      {practiceChosen() && import.meta.env.VITE_WEB_DEMO !== "1" && (
        <button
          className="btn"
          onClick={() => {
            setPractice(false);
            void load();
          }}
          data-dwell
        >
          Leave the practice day
        </button>
      )}

      <section className="stack" aria-label="Telling a carer">
        <h2>
          <Icon name="hand" /> Telling a carer
        </h2>
        <p>
          When this is on, the person can send everyday requests ("I'm cold", "Turn me, please") to one carer.
          Each one is sent once, only after the person confirms exactly what goes to whom, and it says it
          isn't an emergency. It uses the Lifeline contacts: practice contacts get a simulated phone; a
          contact with a real number gets a real text only when the coordinator has text messages set up.
          Emergencies still go through Lifeline.
        </p>
        {s && (
          <>
            <Toggle
              label="Let the person tell a carer"
              value={s.carer_notify}
              onChange={(v) =>
                void attempt(
                  () =>
                    dailySource().saveSettings({
                      ...s,
                      carer_notify: v,
                      carer_id: s.carer_id ?? state?.carers[0]?.id ?? null,
                    }),
                  v ? "Telling a carer is on." : "Telling a carer is off.",
                )
              }
              help={
                state?.carer ? `To ${state.carer.name} by ${state.carer.how}` : "Requests only show on screen"
              }
            />
            <label className="field">
              <strong>Who requests go to</strong>
              <select
                value={s.carer_id ?? ""}
                onChange={(e) =>
                  void attempt(
                    () => dailySource().saveSettings({ ...s, carer_id: e.target.value || null }),
                    "Saved.",
                  )
                }
              >
                <option value="">Nobody chosen</option>
                {state?.carers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (
                    {c.simulated ? "practice phone" : c.reachable ? "real text" : "real texts not set up"})
                  </option>
                ))}
              </select>
            </label>
            <Toggle
              label="Say routine reminders out loud"
              value={s.speak_prompts}
              onChange={(v) =>
                void attempt(() => dailySource().saveSettings({ ...s, speak_prompts: v }), "Saved.")
              }
              help={s.speak_prompts ? "Once, when a reminder appears" : "Reminders only show on screen"}
            />
          </>
        )}
      </section>

      <section className="stack" aria-label="Schedule">
        <h2>
          <Icon name="calendar" /> Schedule
        </h2>
        <p>Appointments, visits, care at a set time and reminders. The person sees them in My day, Today.</p>
        {items.length > 0 && (
          <ul className="day-settings-list">
            {items.map((i) => (
              <li key={i.id}>
                <span>
                  <strong>{i.title}</strong> · {KIND_LABEL[i.kind]} · {when(i)}
                  {i.note ? ` · ${i.note}` : ""}
                </span>
                <button
                  className="btn"
                  onClick={() =>
                    void attempt(
                      () => dailySource().saveItems(items.filter((x) => x.id !== i.id)),
                      `Removed ${i.title}.`,
                    )
                  }
                  data-dwell
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid grid-2"
          aria-label="Add to the schedule"
          onSubmit={(e) => {
            e.preventDefault();
            addItem();
          }}
        >
          <label className="field">
            <strong>What</strong>
            <input
              value={draft.title}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="field">
            <strong>Kind</strong>
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as ItemKind })}
            >
              {(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <strong>Time</strong>
            <input
              type="time"
              value={draft.time}
              onChange={(e) => setDraft({ ...draft, time: e.target.value })}
            />
          </label>
          <label className="field">
            <strong>When</strong>
            <select
              value={draft.repeat}
              onChange={(e) => setDraft({ ...draft, repeat: e.target.value as Draft["repeat"] })}
            >
              <option value="once">One day</option>
              <option value="daily">Every day</option>
              <option value="days">Some days of the week</option>
            </select>
          </label>
          {draft.repeat === "once" && (
            <label className="field">
              <strong>Day</strong>
              <input
                type="date"
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              />
            </label>
          )}
          {draft.repeat === "days" && (
            <fieldset className="field day-days">
              <legend>
                <strong>Days</strong>
              </legend>
              {DAYS.map((d, n) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={draft.days.includes(n)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        days: e.target.checked
                          ? [...draft.days, n].sort()
                          : draft.days.filter((x) => x !== n),
                      })
                    }
                  />{" "}
                  {d}
                </label>
              ))}
            </fieldset>
          )}
          <label className="field">
            <strong>Note (optional)</strong>
            <input
              value={draft.note}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>
          <label className="field day-check">
            <input
              type="checkbox"
              checked={draft.byPerson}
              onChange={(e) => setDraft({ ...draft, byPerson: e.target.checked })}
            />{" "}
            The person asked for this one
          </label>
          <div className="row">
            <button className="btn btn-primary" type="submit" data-dwell>
              <Icon name="plus" /> Add to the schedule
            </button>
          </div>
        </form>
      </section>

      <section className="stack" aria-label="Care routines">
        <h2>
          <Icon name="bell" /> Care routines
        </h2>
        <p>
          Gentle reminders that ask, not tell: the person can say done, put one off, or pass it to their
          carer. They only ask during the hours set here. Use the times the person's care team gave you.
          AGENCY isn't a medical device: these are not medication advice or alarms, and nothing happens if a
          reminder isn't answered.
        </p>
        {routines.length > 0 && (
          <ul className="day-settings-list">
            {routines.map((r) => (
              <li key={r.id}>
                <span>
                  <strong>{r.title}</strong> · {everyText(r.every_min)}, {formatTime(r.start)} to{" "}
                  {formatTime(r.end)}
                  {r.enabled ? "" : " · paused"}
                </span>
                <span className="row">
                  <select
                    aria-label={`How often: ${r.title}`}
                    value={r.every_min}
                    onChange={(e) => changeRoutine(r.id, { every_min: Number(e.target.value) })}
                  >
                    {[...new Set([...EVERY, r.every_min])]
                      .sort((a, b) => a - b)
                      .map((m) => (
                        <option key={m} value={m}>
                          {everyText(m)}
                        </option>
                      ))}
                  </select>
                  <input
                    type="time"
                    aria-label={`From: ${r.title}`}
                    value={r.start}
                    onChange={(e) => e.target.value && changeRoutine(r.id, { start: e.target.value })}
                  />
                  <input
                    type="time"
                    aria-label={`Until: ${r.title}`}
                    value={r.end}
                    onChange={(e) => e.target.value && changeRoutine(r.id, { end: e.target.value })}
                  />
                  <button
                    className="btn"
                    onClick={() => changeRoutine(r.id, { enabled: !r.enabled })}
                    data-dwell
                  >
                    {r.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      setRoutines(
                        routines.filter((x) => x.id !== r.id),
                        `Removed ${r.title}.`,
                      )
                    }
                    data-dwell
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          {ROUTINE_TEMPLATES.filter((t) => !routines.some((r) => r.kind === t.kind)).map((t) => (
            <button
              key={t.kind}
              className="btn"
              onClick={() => addRoutine(t.kind, t.title, t.every_min)}
              data-dwell
            >
              <Icon name="plus" /> {t.title}
            </button>
          ))}
        </div>
        <form
          className="row"
          aria-label="Add another routine"
          onSubmit={(e) => {
            e.preventDefault();
            const title = custom.trim();
            if (!title) return;
            addRoutine("other", title.slice(0, 60), 120);
            setCustom("");
          }}
        >
          <label className="field">
            <strong>Another routine</strong>
            <input
              value={custom}
              maxLength={60}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Stretch my hands"
            />
          </label>
          <button className="btn" type="submit" data-dwell>
            <Icon name="plus" /> Add
          </button>
        </form>
      </section>

      <section className="stack" aria-label="The Mac's Calendar">
        <h2>
          <Icon name="calendar" /> The Mac's Calendar
        </h2>
        {calendarAvailable() ? (
          <>
            <p>
              Show today's events from the Calendar app in My day. AGENCY only reads today's events, on this
              Mac, and doesn't save or send them. The first time, macOS asks to allow AGENCY to read the
              Calendar.
            </p>
            <Toggle
              label="Show today's Calendar events"
              value={calendar}
              onChange={(v) => {
                setCalendarOn(v);
                setCalendar(v);
                setCalendarNote(null);
                if (v)
                  void readCalendar().then((r) =>
                    setCalendarNote(
                      r.ok
                        ? `The Calendar has ${r.events.length} event${r.events.length === 1 ? "" : "s"} today.`
                        : r.error,
                    ),
                  );
              }}
            />
            {calendarNote && (
              <p className="muted" role="status">
                {calendarNote}
              </p>
            )}
          </>
        ) : (
          <p>
            Reading the Mac's Calendar needs the AGENCY Mac app. In a browser, the schedule above is all there
            is.
          </p>
        )}
      </section>

      <HomeSettingsSection />
    </Page>
  );
}
