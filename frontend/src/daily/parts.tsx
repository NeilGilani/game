/** What every My day screen shares: the heading, big choices, the bottom bar, and the data with a steady clock. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import { dayKey } from "./day";
import { dailySource } from "./source";
import type { DailyState } from "./types";

export function Head({
  icon = "calendar",
  eyebrow,
  title,
  help,
  badge,
}: {
  icon?: string;
  eyebrow: string;
  title: string;
  help?: ReactNode;
  badge?: ReactNode;
}) {
  // New choices under the gaze: pause selection briefly so a lingering look doesn't pick one.
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    document.getElementById("day-title")?.focus({ preventScroll: true });
  }, [title]);
  return (
    <div className="flow-head day-head">
      <div className="eyebrow">
        <Icon name={icon} size={18} /> {eyebrow} {badge}
      </div>
      <h1 id="day-title" tabIndex={-1}>
        {title}
      </h1>
      {help && <p className="muted day-help">{help}</p>}
    </div>
  );
}

export function PracticeBadge({ label = "Practice" }: { label?: string }) {
  return (
    <span className="day-practice" data-testid="day-practice">
      {label}
    </span>
  );
}

export function Choice({
  label,
  sub,
  icon,
  onPick,
  tone,
  pressed,
  testId,
}: {
  label: string;
  sub?: string;
  icon: string;
  onPick: () => void;
  tone?: "lifeline" | "quiet";
  pressed?: boolean;
  testId?: string;
}) {
  return (
    <button
      className={`choice day-choice${tone === "lifeline" ? " choice-danger" : ""}`}
      data-tone={tone}
      onClick={onPick}
      data-dwell
      aria-pressed={pressed}
      data-testid={testId}
    >
      <span className="choice-pic" aria-hidden>
        <Icon name={icon} size={52} />
      </span>
      <span className="choice-label">{label}</span>
      {sub && <span className="choice-sub">{sub}</span>}
    </button>
  );
}

export function Choices({ children, count, label }: { children: ReactNode; count: number; label: string }) {
  return (
    <div className="flow-options day-options" data-count={count} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** Back, Home, then (on the right) whatever the screen adds. */
export function Bar({ back = "/day", children }: { back?: string | (() => void); children?: ReactNode }) {
  return (
    <div className="flow-bar" role="group" aria-label="Move around">
      <button
        className="btn btn-xl"
        onClick={() => (typeof back === "function" ? back() : navigate(back))}
        data-dwell
      >
        <Icon name="back" /> Back
      </button>
      <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
        <Icon name="home" /> Home
      </button>
      <span className="spacer" />
      {children}
    </div>
  );
}

export function PageButtons({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <>
      <button className="btn btn-xl" onClick={() => onPage(page - 1)} disabled={page === 0} data-dwell>
        <Icon name="left" /> Earlier
      </button>
      <span className="muted" aria-live="polite">
        {page + 1} of {pages}
      </span>
      <button className="btn btn-xl" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} data-dwell>
        Later <Icon name="right" />
      </button>
    </>
  );
}

/** The time now, updated each minute (on the minute), so nothing moves more often than it must. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, []);
  return now;
}

export interface DailyData {
  state: DailyState | null;
  error: string | null;
  reload: () => Promise<void>;
}

/** Today's data, fetched now and every `everyMs` while the page is visible. */
export function useDaily(now: Date, everyMs = 20_000): DailyData {
  const [state, setState] = useState<DailyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const day = dayKey(now);
  const dayRef = useRef(day);
  dayRef.current = day;
  const reload = useCallback(async () => {
    try {
      setState(await dailySource().state(dayRef.current));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "My day couldn't load.");
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!document.hidden) await reload();
      if (!stopped) timer = setTimeout(tick, everyMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [day, everyMs, reload]);
  return { state, error, reload };
}
