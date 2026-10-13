/**
 * My day: today's appointments, visits, care and reminders, three to a page, each with one-look Done, Later and
 * (when it's on) Tell my carer. "Read my day" says it all out loud.
 */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { readAloud } from "../papers/speak";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import {
  clockAt,
  dayKey,
  daySpeech,
  entriesFor,
  entryWhen,
  KIND_WORDS,
  LATER_MINUTES,
  longDay,
  mark,
  unmark,
  type DayEntry,
} from "./model";
import { DayPage, HomeButton, pageOf, Paging, rowsPerPage } from "./parts";
import { updateDaily, useDaily, useNow } from "./store";
import { carerName, TellCarer, useCarer } from "./TellCarer";

function stateWords(e: DayEntry): string {
  if (e.state === "done") return "Done";
  if (e.state === "later") return `Later: back at ${clockAt(e.until!)}`;
  return KIND_WORDS[e.item.kind];
}

export function tellWords(e: DayEntry): string {
  return `About my day: ${e.item.title}${e.item.time ? ` at ${entryWhen(e)}` : ""}. Could you help me with it?`;
}

export function MyDay() {
  const data = useDaily();
  const now = useNow();
  const announce = useAnnounce();
  const { view } = useCarer();
  const carer = carerName(view);
  const [page, setPage] = useState(0);
  const [perPage] = useState(rowsPerPage);
  const [telling, setTelling] = useState<DayEntry | null>(null);

  // Time order only: marking something never moves the rows under the person's gaze.
  const entries = entriesFor(data, dayKey(now), now);
  const p = pageOf(entries, page, perPage);
  const left = entries.filter((e) => e.state !== "done").length;

  if (telling)
    return <TellCarer tab="today" kind="day" words={tellWords(telling)} onDone={() => setTelling(null)} />;

  const act = (e: DayEntry, what: "done" | "later" | "undo") => {
    const t = Date.now();
    updateDaily((d) => (what === "undo" ? unmark(d, e) : mark(d, e, what, t)));
    announce(
      what === "done"
        ? `${e.item.title}: done.`
        : what === "later"
          ? `${e.item.title}: later. It comes back at ${clockAt(t + LATER_MINUTES * 60_000)}.`
          : `${e.item.title}: not done.`,
    );
  };

  return (
    <DayPage
      tab="today"
      title={`Today, ${longDay(now)}`}
      sub={
        entries.length === 0
          ? "Nothing is planned today."
          : left === 0
            ? "Everything on today's list is done."
            : `${left} still to do.`
      }
      actions={
        <>
          <button className="btn btn-xl" onClick={() => readAloud(daySpeech(data, Date.now()))} data-dwell>
            <Icon name="speak" /> Read my day
          </button>
          <button className="btn btn-xl" onClick={() => navigate("/day/remind")} data-dwell>
            <Icon name="plus" /> Remind me
          </button>
        </>
      }
      bar={
        <>
          <HomeButton />
          <span className="spacer" />
          <Paging page={p.page} pages={p.pages} onPage={setPage} />
        </>
      }
    >
      {entries.length === 0 ? (
        <p className="day-empty muted">
          Add something with Remind me, or a helper can add appointments and visits in Settings, For a helper,
          My day and home.
        </p>
      ) : (
        <ul className="day-list" aria-label="Today">
          {p.items.map((e) => (
            <li key={e.item.id} className="day-row" data-state={e.state} data-testid="day-entry">
              <span className="day-when">{entryWhen(e)}</span>
              <span className="day-what">
                <span className="day-title">{e.item.title}</span>
                <span className="day-state">{stateWords(e)}</span>
              </span>
              {e.state === "done" ? (
                <button className="btn day-act" onClick={() => act(e, "undo")} data-dwell>
                  <Icon name="back" /> Not done
                </button>
              ) : (
                <>
                  <button
                    className="btn btn-primary day-act"
                    onClick={() => act(e, "done")}
                    data-dwell
                    aria-label={`Done: ${e.item.title}`}
                  >
                    <Icon name="check" /> Done
                  </button>
                  <button
                    className="btn day-act"
                    onClick={() => act(e, "later")}
                    data-dwell
                    aria-label={`Later: ${e.item.title}`}
                  >
                    <Icon name="clock" /> Later
                  </button>
                  {carer && (
                    <button
                      className="btn day-act"
                      onClick={() => setTelling(e)}
                      data-dwell
                      aria-label={`Tell ${carer}: ${e.item.title}`}
                    >
                      <Icon name="message" /> Tell {carer}
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </DayPage>
  );
}
