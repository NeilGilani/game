/**
 * On Home: what's next today, in one of the usuals' places (Home's twelve tiles stay as they are). A care
 * reminder that is asking comes first. Looking at it opens My day.
 */
import { useEffect, useRef } from "react";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { dueRoutines, entryWhen, nextUp, type NextUp } from "./model";
import { useDaily, useNow } from "./store";

export function cardText(next: NextUp): { kicker: string; title: string; why: string; path: string } {
  if (next.type === "routine")
    return {
      kicker: "Care reminder",
      title: next.routine.label,
      why: "When you're ready",
      path: "/day/care",
    };
  if (next.type === "item")
    return { kicker: "Next today", title: next.entry.item.title, why: entryWhen(next.entry), path: "/day" };
  return { kicker: "My day", title: "Nothing else today", why: "Look to see your day", path: "/day" };
}

export function DayCard() {
  const data = useDaily();
  const now = useNow();
  const c = cardText(nextUp(data, now));
  return (
    <button
      className="usual day-card"
      onClick={() => navigate(c.path)}
      data-dwell
      data-testid="day-card"
      aria-label={`My day. ${c.kicker}: ${c.title}. ${c.why}`}
    >
      <span className="usual-icon">
        <Icon name="calendar" size={28} />
      </span>
      <span className="usual-text">
        <span className="usual-kicker">{c.kicker}</span>
        <span className="usual-title">{c.title}</span>
        <span className="usual-why">{c.why}</span>
      </span>
    </button>
  );
}

/**
 * A gentle spoken reminder when a care routine starts asking: once each time, through the announcer (spoken
 * only when the person has spoken feedback on). Nothing pops up over what they are doing.
 */
export function DailyNudge() {
  const data = useDaily();
  const now = useNow();
  const announce = useAnnounce();
  const told = useRef(new Set<string>());
  useEffect(() => {
    for (const r of dueRoutines(data, now)) {
      const key = `${r.id}@${r.lastDone ?? 0}@${r.snoozedUntil ?? 0}`;
      if (told.current.has(key)) continue;
      told.current.add(key);
      announce(`A gentle reminder: ${r.label}. It's on My day, under Care.`);
    }
  }, [data, now, announce]);
  return null;
}
