/**
 * Pieces every My day screen shares: the four tabs, the page frame, the bar at the bottom (Home and paging, always
 * in the same place), the "look again to confirm" step and the practice note. Every target is at least 96 px with
 * 24 px between targets, and a screen never scrolls: long lists are paged.
 */
import { useEffect, useState, type ReactNode } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";

export type DayTab = "today" | "care" | "home" | "help";

const TABS: { id: DayTab; label: string; icon: string; path: string }[] = [
  { id: "today", label: "Today", icon: "calendar", path: "/day" },
  { id: "care", label: "Care", icon: "clock", path: "/day/care" },
  { id: "home", label: "Home", icon: "home", path: "/day/home" },
  { id: "help", label: "Ask for help", icon: "hand", path: "/day/help" },
];

/** Confirm buttons wait this long, so a look that was resting there can't confirm by accident. */
export const CONFIRM_MS = 1500;

export const PER_PAGE = 3;

/** Rows per page: two on short screens (a 13-inch MacBook), three otherwise. Read once per screen. */
export function rowsPerPage(): number {
  return typeof window !== "undefined" && window.innerHeight < 880 ? 2 : PER_PAGE;
}

export function DayPage({
  tab,
  title,
  sub,
  children,
  bar,
  actions,
}: {
  tab: DayTab;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  bar: ReactNode;
  /** Big buttons beside the heading (the bar keeps only Home and paging, so it never wraps). */
  actions?: ReactNode;
}) {
  // New choices under the gaze: pause selection briefly so a lingering look doesn't pick one.
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, [title]);
  return (
    <div className="day" aria-label="My day">
      <nav className="day-tabs" aria-label="My day">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="day-tab"
            aria-current={t.id === tab ? "page" : undefined}
            onClick={() => navigate(t.path)}
            data-dwell
          >
            <Icon name={t.icon} size={26} flat /> {t.label}
          </button>
        ))}
      </nav>
      <div className="day-head">
        <div>
          <h1 id="day-title" tabIndex={-1}>
            {title}
          </h1>
          {sub && <p className="day-sub">{sub}</p>}
        </div>
        {actions && <div className="day-head-actions">{actions}</div>}
      </div>
      <div className="day-body">{children}</div>
      <div className="day-bar" role="group" aria-label="Move around">
        {bar}
      </div>
    </div>
  );
}

export function HomeButton() {
  return (
    <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
      <Icon name="home" /> Home
    </button>
  );
}

export function BackButton({ onBack, label = "Back" }: { onBack: () => void; label?: string }) {
  return (
    <button className="btn btn-xl" onClick={onBack} data-dwell>
      <Icon name="back" /> {label}
    </button>
  );
}

/** Previous and More, only when there is more than one page. */
export function Paging({
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
        <Icon name="left" /> Previous
      </button>
      <span className="muted" aria-live="polite">
        {page + 1} of {pages}
      </span>
      <button className="btn btn-xl" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} data-dwell>
        More <Icon name="right" />
      </button>
    </>
  );
}

/** A page of `items`, staying on a page that still exists when the list shrinks. */
export function pageOf<T>(
  items: T[],
  page: number,
  per = PER_PAGE,
): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / per));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(p * per, p * per + per), page: p, pages };
}

/** The confirm step: the exact action in words, a yes that waits a moment, and a way back. */
export function LookToConfirm({
  question,
  detail,
  yes,
  onYes,
  onNo,
  busy,
}: {
  question: string;
  detail?: ReactNode;
  yes: string;
  onYes: () => void;
  onNo: () => void;
  busy?: boolean;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const t = setTimeout(() => setReady(true), CONFIRM_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="day-confirm" role="group" aria-label="Are you sure?" data-testid="day-confirm">
      <p className="day-big">{question}</p>
      {detail}
      <p id="day-confirm-why" className="sr-only">
        {ready
          ? "Look here to confirm."
          : "Ready in a moment, so a lingering look can't confirm by accident."}
      </p>
      <div className="day-actions">
        <button className="btn btn-xl" onClick={onNo} disabled={busy} data-dwell>
          <Icon name="back" /> No, go back
        </button>
        <span className="spacer" />
        <button
          className="btn btn-xl btn-primary"
          onClick={onYes}
          disabled={!ready || busy}
          data-dwell
          data-approval-gate
          aria-describedby="day-confirm-why"
        >
          <Icon name="check" /> {busy ? "Working…" : ready ? yes : "One moment…"}
        </button>
      </div>
    </div>
  );
}

export function PracticeNote({ children }: { children: ReactNode }) {
  return (
    <p className="day-practice" role="note">
      <Icon name="shield" size={20} /> <span>{children}</span>
    </p>
  );
}

/** Non-urgent requests: big tiles that can be said out loud or sent to the chosen carer. */
export interface HelpRequestDef {
  id: string;
  label: string;
  icon: string;
  /** What is said out loud, and sent if the person chooses. */
  words: string;
}

export const HELP_REQUESTS: HelpRequestDef[] = [
  {
    id: "cold",
    label: "I'm cold",
    icon: "weather",
    words: "I'm cold. Could you bring a blanket or turn the heating up?",
  },
  { id: "warm", label: "I'm too warm", icon: "weather", words: "I'm too warm. Could you help me cool down?" },
  {
    id: "turn",
    label: "Turn me, please",
    icon: "refresh",
    words: "Could you help me change position, please?",
  },
  {
    id: "bathroom",
    label: "I need the bathroom",
    icon: "hand",
    words: "I need help with the bathroom, please.",
  },
  { id: "drink", label: "I'd like a drink", icon: "food", words: "I'd like a drink, please." },
  {
    id: "company",
    label: "Come and see me",
    icon: "name",
    words: "Could you come and see me when you have a moment? It isn't urgent.",
  },
];
