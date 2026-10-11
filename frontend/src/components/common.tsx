import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/** Fired when new choices appear under the person's gaze (dialogs, screen changes). */
export const SELECTION_RESET_EVENT = "agency:selection-reset";

/**
 * Gaze-friendly paging: big Previous / Next targets instead of scrolling.
 * With `from: "end"` the newest page is shown until the person pages back.
 */
export function usePaged<T>(items: T[], perPage: number, from: "start" | "end" = "start") {
  const [chosen, setChosen] = useState<number | null>(null);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const fallback = from === "end" ? pages - 1 : 0;
  const current = Math.min(chosen ?? fallback, pages - 1);
  // Anchored at the end, the newest page is always full and older pages hold the remainder.
  const start = from === "end" ? Math.max(0, items.length - (pages - current) * perPage) : current * perPage;
  const end = from === "end" ? items.length - (pages - 1 - current) * perPage : start + perPage;
  return {
    items: items.slice(start, end),
    page: current,
    pages,
    next: () => setChosen(Math.min(pages - 1, current + 1)),
    prev: () => setChosen(Math.max(0, current - 1)),
  };
}

export function Pager({
  page,
  pages,
  onPrev,
  onNext,
  label,
}: {
  page: number;
  pages: number;
  onPrev: () => void;
  onNext: () => void;
  label: string;
}) {
  if (pages <= 1) return null;
  return (
    <div className="row" role="group" aria-label={`${label} pages`}>
      <button className="btn" onClick={onPrev} disabled={page === 0} data-dwell>
        <Icon name="left" /> Previous
      </button>
      <span className="muted" aria-live="polite">
        Page {page + 1} of {pages}
      </span>
      <button className="btn" onClick={onNext} disabled={page >= pages - 1} data-dwell>
        Next <Icon name="right" />
      </button>
    </div>
  );
}

/**
 * Confirmation for consequential actions. The confirm button sits on the opposite side
 * from where the triggering button was, and selection is paused briefly when it opens,
 * so a lingering gaze can't confirm by accident.
 */
export function ConfirmSheet({
  title,
  children,
  confirmLabel,
  cancelLabel = "Go back",
  onConfirm,
  onCancel,
  busy,
  tone = "primary",
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  tone?: "primary" | "danger";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    // Pause hands-free selection briefly so a lingering gaze can't confirm by accident.
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="sheet-backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        data-dwell-scope="modal"
        ref={ref}
      >
        <h2 id="sheet-title">{title}</h2>
        {children}
        <div className="sheet-actions">
          <button
            className="btn btn-xl btn-quiet"
            onClick={onCancel}
            data-dwell
            data-autofocus
            disabled={busy}
          >
            <Icon name="back" /> {cancelLabel}
          </button>
          <button
            className={`btn btn-xl ${tone === "danger" ? "btn-solid-danger" : "btn-primary"}`}
            onClick={onConfirm}
            data-dwell
            data-approval-gate
            disabled={busy}
          >
            <Icon name="check" /> {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="panel panel-danger row" role="alert">
      <Icon name="alert" />
      <span>{message}</span>
      <span className="spacer" />
      {onRetry && (
        <button className="btn" onClick={onRetry} data-dwell>
          <Icon name="refresh" /> Try again
        </button>
      )}
    </div>
  );
}
