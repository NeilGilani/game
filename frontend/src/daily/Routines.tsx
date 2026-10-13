/**
 * Care routines that ask, not tell: gentle prompts the person can do, put off, or pass to their carer. They are
 * reminders with times the person or their care team chose. Not medication advice, not clinical alarms.
 */
import { useState } from "react";
import { ErrorNote } from "../components/common";
import { formatClock, everyText, isDue, nextDue, routinePrompt } from "./day";
import { Badge, RoutineActions } from "./MyDay";
import { Bar, Head, PageButtons, useDaily, useNow } from "./parts";

const PER_PAGE = 2;

export function Routines() {
  const now = useNow();
  const { state, error, reload } = useDaily(now);
  const [page, setPage] = useState(0);
  const list = (state?.routines ?? [])
    .filter((r) => r.enabled)
    .map((r) => ({
      r,
      due: isDue(r, state!.routine_state[r.id], now),
      at: nextDue(r, state!.routine_state[r.id], now),
    }))
    .sort((a, b) => Number(b.due) - Number(a.due) || a.at.getTime() - b.at.getTime());
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = list.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);
  const dueCount = list.filter((x) => x.due).length;

  return (
    <div className="flow day" aria-label="Routines" data-testid="day-routines">
      <Head
        icon="bell"
        eyebrow="Routines"
        badge={<Badge />}
        title={
          !state
            ? "Routines"
            : list.length === 0
              ? "No routines yet"
              : dueCount
                ? "Whenever you're ready"
                : "Nothing to answer now"
        }
        help={
          list.length === 0
            ? "A helper can add gentle reminders, like changing position or a drink of water, in Settings, My day."
            : "Gentle reminders, not alarms or medical advice. Put one off whenever you like."
        }
      />
      <div className="day-body">
        {error && <ErrorNote message={error} onRetry={() => void reload()} />}
        <ul className="day-list" aria-label="Routines">
          {shown.map(({ r, due, at }) => (
            <li className="day-routine" key={r.id} data-due={due} data-testid={`day-routine-${r.id}`}>
              <div className="day-item-what">
                <span className="day-item-title">{due ? routinePrompt(r) : r.title}</span>
                <span className="day-item-note">
                  {due
                    ? `Asks ${everyText(r.every_min)}`
                    : `Next at ${formatClock(at)} · asks ${everyText(r.every_min)}`}
                </span>
              </div>
              {due && <RoutineActions routine={r} onDone={() => void reload()} compact />}
            </li>
          ))}
        </ul>
      </div>
      <Bar>
        <PageButtons page={current} pages={pages} onPage={setPage} />
      </Bar>
    </div>
  );
}
