/**
 * Care routines that ask, not tell: what's asking now first, then what's next. Done, Later (snooze), and Tell my
 * carer only when the person chooses. These are reminders the person and their care team set up: not medication
 * dosing advice and not clinical alarms, and the screen says so.
 */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { clockAt, every, isDue, nextDue, routineDone, routineLater, type Routine } from "./model";
import { DayPage, HomeButton, pageOf, Paging, rowsPerPage } from "./parts";
import { updateDaily, useDaily, useNow } from "./store";
import { carerName, TellCarer, useCarer } from "./TellCarer";

export function routineTellWords(r: Routine): string {
  return `Care reminder: ${r.label}. Could you help me with it when you can?`;
}

export function CareRoutines() {
  const data = useDaily();
  const now = useNow();
  const announce = useAnnounce();
  const { view } = useCarer();
  const carer = carerName(view);
  const [page, setPage] = useState(0);
  const [perPage] = useState(rowsPerPage);
  const [telling, setTelling] = useState<Routine | null>(null);

  if (telling)
    return (
      <TellCarer
        tab="care"
        kind="routine"
        words={routineTellWords(telling)}
        onDone={() => setTelling(null)}
      />
    );

  const routines = data.routines
    .filter((r) => r.enabled)
    // In the order they were set up: Done or Later never moves the rows under the person's gaze.
    .map((r) => ({ r, due: nextDue(r, now)! }));
  const p = pageOf(routines, page, perPage);
  const asking = routines.filter(({ r }) => isDue(r, now)).length;

  const done = (r: Routine) => {
    updateDaily((d) => routineDone(d, r.id, Date.now()));
    announce(`${r.label}: done. Next at ${clockAt(Date.now() + r.everyMinutes * 60_000)}.`);
  };
  const later = (r: Routine) => {
    updateDaily((d) => routineLater(d, r.id, Date.now()));
    announce(`${r.label}: later. I'll ask again at ${clockAt(Date.now() + r.snoozeMinutes * 60_000)}.`);
  };

  return (
    <DayPage
      tab="care"
      title={asking ? `${asking} asking now` : "Care reminders"}
      sub="Gentle reminders you and your care team set. Not medical advice and not an alarm."
      bar={
        <>
          <HomeButton />
          <span className="spacer" />
          <Paging page={p.page} pages={p.pages} onPage={setPage} />
        </>
      }
    >
      {routines.length === 0 ? (
        <p className="day-empty muted">
          No care reminders yet. A helper can add them (changing position, eye drops, mouth care, water) in
          Settings, For a helper, My day and home.
        </p>
      ) : (
        <ul className="day-list" aria-label="Care reminders">
          {p.items.map(({ r, due }) => {
            const asks = due <= now;
            return (
              <li key={r.id} className="day-row" data-state={asks ? "due" : "open"} data-testid="day-routine">
                <span className="day-when">{asks ? "Now" : clockAt(due)}</span>
                <span className="day-what">
                  <span className="day-title">{r.label}</span>
                  <span className="day-state">
                    {asks ? "When you're ready" : "Next"} · {every(r.everyMinutes)}
                  </span>
                </span>
                <button
                  className={`btn day-act ${asks ? "btn-primary" : ""}`}
                  onClick={() => done(r)}
                  data-dwell
                  aria-label={`Done: ${r.label}`}
                >
                  <Icon name="check" /> Done
                </button>
                {asks && (
                  <button
                    className="btn day-act"
                    onClick={() => later(r)}
                    data-dwell
                    aria-label={`Later: ${r.label}`}
                  >
                    <Icon name="clock" /> Later
                  </button>
                )}
                {asks && carer && (
                  <button
                    className="btn day-act"
                    onClick={() => setTelling(r)}
                    data-dwell
                    aria-label={`Tell ${carer}: ${r.label}`}
                  >
                    <Icon name="message" /> Tell {carer}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DayPage>
  );
}
