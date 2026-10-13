/**
 * My day: a calm hub (what's next, routines, the home, asking for help, hearing the day read aloud) and the day's
 * schedule, with one-look Done, Later and Tell my carer on every item.
 */
import { useEffect, useState } from "react";
import { ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { readAloud } from "../papers/speak";
import { navigate } from "../state/router";
import { todaysCalendar } from "./calendar";
import {
  agenda,
  daySummary,
  dayKey,
  dueRoutines,
  formatTime,
  KIND_LABEL,
  laterTime,
  routinePrompt,
  type AgendaEntry,
} from "./day";
import { Bar, Choice, Choices, Head, PageButtons, PracticeBadge, useDaily, useNow } from "./parts";
import { dailySource, practiceChosen, setPractice } from "./source";
import { tellPath } from "./tell";
import type { DailyState, Routine, ScheduleItem } from "./types";

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
/** Minutes a one-look "Later" puts something off by. */
export const LATER_MIN = 30;

function useCalendar(now: Date): { items: ScheduleItem[]; error: string | null } {
  const [cal, setCal] = useState<{ items: ScheduleItem[]; error: string | null }>({ items: [], error: null });
  const day = dayKey(now);
  useEffect(() => {
    let live = true;
    void todaysCalendar().then((c) => live && setCal(c));
    return () => {
      live = false;
    };
  }, [day]);
  return cal;
}

function entriesFor(state: DailyState | null, calendar: ScheduleItem[], now: Date): AgendaEntry[] {
  return state ? agenda([...state.items, ...calendar], state.marks, now) : [];
}

export function Badge() {
  if (dailySource().kind !== "practice") return null;
  return <PracticeBadge />;
}

/** Done / Put off / Tell my carer for a due routine. Shared by the hub, Routines and the nudge. */
export function RoutineActions({
  routine,
  onDone,
  compact,
}: {
  routine: Routine;
  onDone: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div
        className={`day-actions${compact ? " day-actions-compact" : ""}`}
        role="group"
        aria-label={routine.title}
      >
        <button
          className="btn btn-xl btn-primary"
          disabled={busy}
          onClick={() => void act(() => dailySource().routineDone(routine.id))}
          data-dwell
        >
          <Icon name="check" /> Done
        </button>
        <button
          className="btn btn-xl"
          disabled={busy}
          onClick={() => void act(() => dailySource().routineLater(routine.id, LATER_MIN))}
          data-dwell
        >
          <Icon name="clock" /> In {LATER_MIN} minutes
        </button>
        <button
          className="btn btn-xl"
          disabled={busy}
          onClick={() => navigate(tellPath("routine", `Please help me: ${routine.title.toLowerCase()}`))}
          data-dwell
        >
          <Icon name="hand" /> Tell my carer
        </button>
      </div>
      {error && <ErrorNote message={error} />}
    </>
  );
}

export function MyDayHub() {
  const now = useNow();
  const { state, error, reload } = useDaily(now);
  const calendar = useCalendar(now);
  const entries = entriesFor(state, calendar.items, now);
  const due = state ? dueRoutines(state.routines, state.routine_state, now) : [];
  const next = entries.find((e) => e.status === "next");
  const left = entries.filter((e) => e.status === "next" || e.status === "upcoming" || e.status === "later");
  const title = due[0]
    ? routinePrompt(due[0])
    : next
      ? `Next: ${next.item.title} at ${formatTime(next.at)}`
      : "Your day";
  const nextRoutine = state?.routines.find((r) => r.enabled && !due.includes(r));

  return (
    <div className="flow day" aria-label="My day" data-testid="my-day">
      <Head
        eyebrow={`My day · ${WEEKDAY.format(now)}`}
        badge={<Badge />}
        title={state ? title : "My day"}
        help={due[0] ? "Only if you'd like to. Nothing happens if you don't answer." : undefined}
      />
      <div className="day-body">
        {error && <ErrorNote message={error} onRetry={() => void reload()} />}
        {due[0] && <RoutineActions routine={due[0]} onDone={() => void reload()} />}
        <Choices count={5} label="My day">
          <Choice
            icon="calendar"
            label="Today"
            sub={
              !state
                ? "Loading…"
                : left.length
                  ? `${left.length} still to come${next ? `, next at ${formatTime(next.at)}` : ""}`
                  : entries.length
                    ? "Nothing more planned"
                    : "Nothing planned yet"
            }
            onPick={() => navigate("/day/today")}
          />
          <Choice
            icon="bell"
            label="Routines"
            sub={
              due.length
                ? `${due.length} to answer`
                : nextRoutine
                  ? `${nextRoutine.title}, later`
                  : state?.routines.length
                    ? "All answered"
                    : "None set up yet"
            }
            onPick={() => navigate("/day/routines")}
          />
          <Choice
            icon="home"
            label="The home"
            sub="Lights, TV, fan, heating"
            onPick={() => navigate("/day/home")}
          />
          <Choice
            icon="hand"
            label="Ask for help"
            sub="Not urgent: tell your carer"
            onPick={() => navigate("/day/help")}
          />
          <Choice
            icon="speak"
            label="Read my day"
            sub="Hear what's next"
            onPick={() => readAloud(daySummary(entries, due, now))}
          />
        </Choices>
      </div>
      <Bar back="/">
        {dailySource().kind === "practice" && practiceChosen() && import.meta.env.VITE_WEB_DEMO !== "1" && (
          <button
            className="btn btn-xl"
            onClick={() => {
              setPractice(false);
              void reload();
            }}
            data-dwell
          >
            <Icon name="x" /> Leave practice
          </button>
        )}
      </Bar>
    </div>
  );
}

/** Two plans a page: six choices and the bar, and it fits a 1280 × 800 screen. */
const PER_PAGE = 2;

function statusText(e: AgendaEntry): string {
  if (e.status === "done") return "Done";
  if (e.status === "later") return `Later, at ${formatTime(e.at)}`;
  if (e.status === "next") return "Next";
  if (e.status === "earlier") return "Earlier today";
  return "";
}

function ItemRow({
  entry,
  day,
  now,
  onChange,
}: {
  entry: AgendaEntry;
  day: string;
  now: Date;
  onChange: () => void;
}) {
  const { item, status } = entry;
  const [error, setError] = useState<string | null>(null);
  const mark = async (s: "done" | "later" | "clear") => {
    try {
      await dailySource().mark({
        item_id: item.id,
        day,
        status: s,
        ...(s === "later" ? { until: laterTime(now, LATER_MIN) } : {}),
      });
      setError(null);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  };
  const said = `${KIND_LABEL[item.kind]}: ${item.title} at ${formatTime(entry.at)}`;
  return (
    <li className="day-item" data-status={status} data-testid={`day-item-${item.id}`}>
      <div className="day-item-when">
        <span className="day-item-time">{formatTime(entry.at)}</span>
        <span className="day-item-status">{statusText(entry)}</span>
      </div>
      <div className="day-item-what">
        <span className="day-item-title">{item.title}</span>
        <span className="day-item-note">
          {[
            KIND_LABEL[item.kind],
            item.note,
            item.fromCalendar ? "From your Mac's Calendar" : item.set_by === "person" ? "You added this" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {error && <span className="day-error">{error}</span>}
      </div>
      <div className="day-actions" role="group" aria-label={item.title}>
        {item.fromCalendar ? null : status === "done" ? (
          <button className="btn btn-xl" onClick={() => void mark("clear")} data-dwell>
            <Icon name="back" /> Not done
          </button>
        ) : (
          <>
            <button
              className="btn btn-xl btn-primary"
              onClick={() => void mark("done")}
              data-dwell
              aria-label={`Done: ${item.title}`}
            >
              <Icon name="check" /> Done
            </button>
            <button
              className="btn btn-xl"
              onClick={() => void mark("later")}
              data-dwell
              aria-label={`Later: ${item.title}`}
            >
              <Icon name="clock" /> Later
            </button>
          </>
        )}
        <button
          className="btn btn-xl"
          onClick={() => navigate(tellPath("schedule", said))}
          data-dwell
          aria-label={`Tell my carer: ${item.title}`}
        >
          <Icon name="hand" /> Tell my carer
        </button>
      </div>
    </li>
  );
}

export function Today() {
  const now = useNow();
  const { state, error, reload } = useDaily(now);
  const calendar = useCalendar(now);
  const entries = entriesFor(state, calendar.items, now);
  const [page, setPage] = useState<number | null>(null);
  const due = state ? dueRoutines(state.routines, state.routine_state, now) : [];
  const pages = Math.max(1, Math.ceil(entries.length / PER_PAGE));
  // Open on the page with what's next, once. After that the page only changes when the person turns it, so
  // marking something done never moves the plans under their eyes.
  const nextAt = Math.max(
    0,
    entries.findIndex((e) => e.status === "next" || e.status === "later"),
  );
  const loaded = state !== null;
  useEffect(() => {
    if (loaded && page === null) setPage(Math.floor(nextAt / PER_PAGE));
  }, [loaded, page, nextAt]);
  const current = Math.min(page ?? Math.floor(nextAt / PER_PAGE), pages - 1);
  const shown = entries.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);
  const empty = state && entries.length === 0;

  return (
    <div className="flow day" aria-label="Today" data-testid="day-today">
      <Head
        eyebrow={`Today · ${WEEKDAY.format(now)}`}
        badge={<Badge />}
        title={empty ? "Nothing is planned yet" : "Your day"}
        help={
          empty
            ? "A helper can add appointments, visits and reminders in Settings, My day."
            : `It's ${formatTime(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`)}.`
        }
      />
      <div className="day-body">
        {error && <ErrorNote message={error} onRetry={() => void reload()} />}
        {calendar.error && <p className="panel panel-muted small">{calendar.error}</p>}
        {empty && dailySource().kind === "coordinator" && (
          <Choices count={1} label="Practice">
            <Choice
              icon="sparkle"
              label="Try a practice day"
              sub="Made-up plans, only on this screen"
              onPick={() => {
                setPractice(true);
                void reload();
              }}
            />
          </Choices>
        )}
        {shown.length > 0 && (
          <ol className="day-list" aria-label="Today's plans">
            {shown.map((e) => (
              <ItemRow key={e.item.id} entry={e} day={dayKey(now)} now={now} onChange={() => void reload()} />
            ))}
          </ol>
        )}
      </div>
      <Bar>
        <button className="btn btn-xl" onClick={() => readAloud(daySummary(entries, due, now))} data-dwell>
          <Icon name="speak" /> Read aloud
        </button>
        <PageButtons
          page={current}
          pages={pages}
          onPage={(p) => {
            setPage(p);
          }}
        />
      </Bar>
    </div>
  );
}
