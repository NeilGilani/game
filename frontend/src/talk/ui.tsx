/** Small building blocks shared by the Talk screens: big paging, headers, notes. */

import { useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";

export function usePages<T>(items: readonly T[], perPage: number) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, pages - 1);
  return {
    items: items.slice(current * perPage, current * perPage + perPage),
    page: current,
    pages,
    prev: () => setPage(Math.max(0, current - 1)),
    next: () => setPage(Math.min(pages - 1, current + 1)),
    reset: () => setPage(0),
  };
}

/** Previous / Next as 96 px targets; nothing scrolls under the gaze. */
export function BigPager({
  page,
  pages,
  prev,
  next,
  label,
}: {
  page: number;
  pages: number;
  prev: () => void;
  next: () => void;
  label: string;
}) {
  if (pages <= 1) return null;
  return (
    <div className="talk-pager" role="group" aria-label={`${label} pages`}>
      <button className="btn talk-btn" onClick={prev} disabled={page === 0} data-dwell>
        <Icon name="left" /> Previous
      </button>
      <span className="talk-pager-count" aria-live="polite">
        {label}: page {page + 1} of {pages}
      </span>
      <button className="btn talk-btn" onClick={next} disabled={page >= pages - 1} data-dwell>
        Next <Icon name="right" />
      </button>
    </div>
  );
}

export function SimNote({ children }: { children: ReactNode }) {
  return (
    <p className="talk-sim" role="note">
      <Icon name="info" size={20} /> <span>{children}</span>
    </p>
  );
}

export function ScreenHead({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="talk-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}
