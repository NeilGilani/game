/**
 * Remind me: the person adds their own reminder by eye, in two choices (what, then when). No typing.
 */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { at, clock, dayKey, MAX_ITEMS, type DayItem } from "./model";
import { BackButton, DayPage } from "./parts";
import { loadDaily, newId, updateDaily } from "./store";

export const REMIND_WHAT: { id: string; label: string; icon: string }[] = [
  { id: "call", label: "Call someone", icon: "phone" },
  { id: "rest", label: "Have a rest", icon: "pause" },
  { id: "show", label: "Watch my show", icon: "tv" },
  { id: "drink", label: "Have a drink", icon: "food" },
  { id: "message", label: "Send a message", icon: "message" },
  { id: "air", label: "Get some fresh air", icon: "weather" },
];

export interface WhenChoice {
  id: string;
  label: string;
  date: string;
  time: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function hhmm(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Later today and tomorrow morning, rounded to five minutes. "This evening" only while it's still to come. */
export function whenChoices(now: number): WhenChoice[] {
  const round = (t: number) => Math.ceil(t / 300_000) * 300_000;
  const inMinutes = (id: string, label: string, m: number): WhenChoice => {
    const t = round(now + m * 60_000);
    return { id, label, date: dayKey(t), time: hhmm(t) };
  };
  const out = [
    inMinutes("30m", "In 30 minutes", 30),
    inMinutes("1h", "In an hour", 60),
    inMinutes("2h", "In 2 hours", 120),
  ];
  if (now < at(now, "17:30"))
    out.push({ id: "evening", label: "This evening", date: dayKey(now), time: "18:00" });
  const tomorrow = at(now, "12:00") + 86_400_000;
  out.push({ id: "tomorrow", label: "Tomorrow morning", date: dayKey(tomorrow), time: "09:00" });
  return out;
}

export function reminderItem(what: string, when: WhenChoice, id: string): DayItem {
  return {
    id,
    title: what,
    kind: "reminder",
    date: when.date,
    time: when.time,
    repeat: "once",
    addedBy: "person",
  };
}

export function RemindMe() {
  const announce = useAnnounce();
  const [what, setWhat] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (saved)
    return (
      <DayPage
        tab="today"
        title={saved}
        bar={
          <button className="btn btn-xl btn-primary" onClick={() => navigate("/day")} data-dwell>
            <Icon name="check" /> Back to my day
          </button>
        }
      >
        <span />
      </DayPage>
    );

  if (what) {
    const choices = whenChoices(Date.now());
    const save = (w: WhenChoice) => {
      const full = loadDaily().items.length >= MAX_ITEMS;
      if (!full) updateDaily((d) => ({ ...d, items: [...d.items, reminderItem(what, w, newId("me"))] }));
      const text = full
        ? "Your list is full. A helper can remove old items in settings."
        : `I'll remind you: ${what}, ${w.label.toLowerCase()} (${clock(w.time)}).`;
      announce(text);
      setSaved(text);
    };
    return (
      <DayPage tab="today" title={`${what}: when?`} bar={<BackButton onBack={() => setWhat(null)} />}>
        <div className="flow-options" data-count={choices.length} role="group" aria-labelledby="day-title">
          {choices.map((w) => (
            <button key={w.id} className="choice" onClick={() => save(w)} data-dwell>
              <span className="choice-pic" aria-hidden>
                <Icon name="clock" size={44} />
              </span>
              <span className="choice-label">{w.label}</span>
              <span className="choice-sub">{clock(w.time)}</span>
            </button>
          ))}
        </div>
      </DayPage>
    );
  }

  return (
    <DayPage
      tab="today"
      title="Remind me to…"
      bar={<BackButton label="My day" onBack={() => navigate("/day")} />}
    >
      <div className="flow-options" data-count={REMIND_WHAT.length} role="group" aria-labelledby="day-title">
        {REMIND_WHAT.map((w) => (
          <button key={w.id} className="choice" onClick={() => setWhat(w.label)} data-dwell>
            <span className="choice-pic" aria-hidden>
              <Icon name={w.icon} size={44} />
            </span>
            <span className="choice-label">{w.label}</span>
          </button>
        ))}
      </div>
    </DayPage>
  );
}
