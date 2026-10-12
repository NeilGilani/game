/**
 * AGENCY Browser's questions, as big sheets over the page (the page is hidden while one is open):
 * a site asking for a permission, a download, "are you sure?" before the person's own choice pays or sends, a
 * list's options, a pop-up's own buttons, and More (zoom, history, favourites).
 */
import { useEffect, useRef, useState } from "react";
import { SELECTION_RESET_EVENT, usePaged } from "../components/common";
import { Icon } from "../components/Icon";
import { useDialogFocus } from "../components/useDialogFocus";
import { navigate } from "../state/router";
import type { Sheet } from "./BrowserScreen";
import { forgetTyped } from "./FormPanel";
import { displayUrl } from "./omnibox";
import type {
  BrowserApi,
  BrowserPrompt,
  BrowserTab,
  ConsequentialKind,
  HistoryEntry,
  PopupInfo,
} from "./store";

/** The pause before a "yes" can be chosen, so a lingering look can't agree by accident. */
export const YES_PAUSE_MS = 1500;

function useReady(key: string, ms = YES_PAUSE_MS): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const t = window.setTimeout(() => setReady(true), ms);
    return () => window.clearTimeout(t);
  }, [key, ms]);
  return ready;
}

function SheetFrame({
  title,
  children,
  onEscape,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onEscape: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onEscape);
  return (
    <div className="sheet-backdrop bw-sheet-backdrop">
      <div
        className={`sheet bw-sheet ${wide ? "bw-sheet-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-dwell-scope="modal"
        ref={ref}
      >
        {children}
      </div>
    </div>
  );
}

const PERMISSION_WORDS: Record<string, { what: string; icon: string }> = {
  location: { what: "know where you are", icon: "globe" },
  microphone: { what: "use your microphone", icon: "voice" },
  notifications: { what: "send you notifications", icon: "bell" },
  clipboard: { what: "read what you copied", icon: "document" },
  camera: { what: "use your camera", icon: "camera" },
};

function sizeText(bytes: number | null): string {
  if (!bytes) return "size unknown";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PromptSheet({ api, prompt }: { api: BrowserApi; prompt: BrowserPrompt }) {
  const ready = useReady(prompt.id);
  if (prompt.type === "permission") {
    const w = PERMISSION_WORDS[prompt.permission] ?? { what: prompt.permission, icon: "question" };
    return (
      <SheetFrame title="A site is asking" onEscape={() => api.answer(prompt.id, "deny")} wide>
        <h2 className="bw-sheet-title">
          <Icon name={w.icon} size={30} flat /> {displayUrl(prompt.origin)} wants to {w.what}
        </h2>
        <p className="bw-sheet-text">
          Only say yes if you trust this site. You can change your mind in Settings.
        </p>
        <div className="bw-sheet-actions">
          <button
            className="btn btn-xl"
            onClick={() => api.answer(prompt.id, "deny")}
            data-dwell
            data-autofocus
          >
            <Icon name="x" /> Not now
          </button>
          <button className="btn btn-xl btn-quiet" onClick={() => api.answer(prompt.id, "never")} data-dwell>
            Never on this site
          </button>
          <span className="spacer" />
          <button
            className="btn btn-xl btn-primary"
            onClick={() => api.answer(prompt.id, "allow")}
            disabled={!ready}
            data-dwell
          >
            <Icon name="check" /> {ready ? "Allow on this site" : "One moment…"}
          </button>
        </div>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title="Save a file" onEscape={() => api.answer(prompt.id, "cancel")}>
      <h2 className="bw-sheet-title">
        <Icon name="document" size={30} flat /> Save “{prompt.filename}” to Downloads?
      </h2>
      <p className="bw-sheet-text">
        From {prompt.origin}, {sizeText(prompt.bytes)}.
      </p>
      {prompt.program && (
        <p className="bw-sheet-warn" role="alert">
          <Icon name="alert" size={24} flat /> This is a program. Programs from the internet can harm your
          computer: only save it if a helper says so.
        </p>
      )}
      <div className="bw-sheet-actions">
        <button
          className="btn btn-xl"
          onClick={() => api.answer(prompt.id, "cancel")}
          data-dwell
          data-autofocus
        >
          <Icon name="x" /> Don&apos;t save
        </button>
        <span className="spacer" />
        <button
          className="btn btn-xl btn-primary"
          onClick={() => api.answer(prompt.id, "save")}
          disabled={!ready}
          data-dwell
        >
          <Icon name="check" /> {ready ? "Save to Downloads" : "One moment…"}
        </button>
      </div>
    </SheetFrame>
  );
}

const VERB: Record<ConsequentialKind, string> = {
  send: "send something",
  purchase: "pay or buy",
  sign: "sign something",
  call: "start a call",
  submit: "send this form",
  delete: "delete something",
  "share-personal-data": "share your personal details",
  "account-or-settings": "change an account or setting",
  install: "install something",
};

export function ConfirmSheet({
  sheet,
  onYes,
  onNo,
}: {
  sheet: Extract<Sheet, { type: "confirm" }>;
  onYes: () => void;
  onNo: () => void;
}) {
  const ready = useReady(`${sheet.ref}:${sheet.action}`);
  return (
    <SheetFrame title="Are you sure?" onEscape={onNo}>
      <h2 className="bw-sheet-title">
        <Icon name="hand" size={30} flat /> This may {VERB[sheet.action]}.
      </h2>
      <p className="bw-sheet-text">
        You chose <strong>“{sheet.label}”</strong> on {sheet.origin}. Do you want to go ahead?
      </p>
      <div className="bw-sheet-actions">
        <button className="btn btn-xl" onClick={onNo} data-dwell data-autofocus>
          <Icon name="back" /> No, go back
        </button>
        <span className="spacer" />
        <button
          className="btn btn-xl btn-primary"
          onClick={onYes}
          disabled={!ready}
          data-dwell
          data-approval-gate
        >
          <Icon name="check" /> {ready ? "Yes, go ahead" : "One moment…"}
        </button>
      </div>
    </SheetFrame>
  );
}

export function ListSheet({
  sheet,
  onPick,
  onClose,
}: {
  sheet: Extract<Sheet, { type: "list" }>;
  onPick: (option: string) => void;
  onClose: () => void;
}) {
  const paged = usePaged(sheet.options, 8);
  return (
    <SheetFrame title={sheet.label} onEscape={onClose} wide>
      <h2 className="bw-sheet-title">{sheet.label}</h2>
      <div className="bw-sheet-options" data-count={paged.items.length}>
        {paged.items.map((o) => (
          <button
            key={o}
            className="bw-option"
            aria-pressed={o === sheet.selected}
            onClick={() => onPick(o)}
            data-dwell
          >
            {o === sheet.selected && <Icon name="check" size={24} />} {o}
          </button>
        ))}
      </div>
      <div className="bw-sheet-actions">
        <button className="btn btn-xl" onClick={onClose} data-dwell>
          <Icon name="x" /> Cancel
        </button>
        <span className="spacer" />
        {paged.pages > 1 && (
          <>
            <button className="btn btn-xl" onClick={paged.prev} disabled={paged.page === 0} data-dwell>
              <Icon name="left" /> Previous
            </button>
            <button
              className="btn btn-xl"
              onClick={paged.next}
              disabled={paged.page >= paged.pages - 1}
              data-dwell
            >
              More <Icon name="right" />
            </button>
          </>
        )}
      </div>
    </SheetFrame>
  );
}

const TONE_ICON: Record<string, string> = { decline: "shield", close: "x", accept: "check", other: "info" };

export function PopupSheet({
  info,
  onChoose,
  onClose,
}: {
  info: PopupInfo | null;
  onChoose: (ref: string) => void;
  onClose: () => void;
}) {
  if (!info)
    return (
      <SheetFrame title="No pop-up" onEscape={onClose}>
        <h2 className="bw-sheet-title">
          <Icon name="check" size={30} /> No pop-up found on this page
        </h2>
        <p className="bw-sheet-text">
          If something is still in the way, try Choose on page to find its close button.
        </p>
        <div className="bw-sheet-actions">
          <button className="btn btn-xl btn-primary" onClick={onClose} data-dwell>
            OK
          </button>
        </div>
      </SheetFrame>
    );
  return (
    <SheetFrame title="Pop-up" onEscape={onClose} wide>
      <h2 className="bw-sheet-title">
        <Icon name="popup" size={30} flat />{" "}
        {info.kind === "cookies" ? "The site asks about cookies" : "A pop-up is in the way"}
      </h2>
      {info.text && <p className="bw-sheet-quote">“{info.text}”</p>}
      {info.kind === "cookies" && (
        <p className="bw-sheet-text">Reject all shares the least about you. The page works either way.</p>
      )}
      <div className="bw-sheet-options" data-count={info.choices.length + 1}>
        {info.choices.map((c) => (
          <button
            key={c.ref}
            className="bw-option"
            data-tone={c.tone}
            onClick={() => onChoose(c.ref)}
            data-dwell
          >
            <Icon name={TONE_ICON[c.tone] ?? "info"} size={24} flat /> {c.label}
          </button>
        ))}
        <button className="bw-option" onClick={() => onChoose("hide")} data-dwell>
          <Icon name="x" size={24} /> Just hide it
        </button>
      </div>
      <div className="bw-sheet-actions">
        <button className="btn btn-xl" onClick={onClose} data-dwell>
          <Icon name="back" /> Leave it
        </button>
      </div>
    </SheetFrame>
  );
}

function HistoryList({ api, onOpen }: { api: BrowserApi; onOpen: () => void }) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    void api.history().then(setItems, () => setItems([]));
  }, [api]);
  const paged = usePaged(items ?? [], 5);
  if (confirm)
    return (
      <>
        <h2 className="bw-sheet-title">Clear all history?</h2>
        <p className="bw-sheet-text">
          The list of pages you visited is erased from this computer. Sign-ins stay.
        </p>
        <div className="bw-sheet-actions">
          <button className="btn btn-xl" onClick={() => setConfirm(false)} data-dwell>
            <Icon name="back" /> No
          </button>
          <span className="spacer" />
          <button
            className="btn btn-xl btn-danger"
            onClick={() => {
              void api.clearHistory().then(() => {
                forgetTyped();
                setItems([]);
                setConfirm(false);
              });
            }}
            data-dwell
          >
            Yes, clear history
          </button>
        </div>
      </>
    );
  return (
    <>
      <h2 className="bw-sheet-title">
        <Icon name="clock" size={28} flat /> History
      </h2>
      <div className="bw-history">
        {items === null ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No pages yet.</p>
        ) : (
          paged.items.map((h) => (
            <button
              key={`${h.url}-${h.at}`}
              className="bw-recent-item"
              onClick={() => {
                void api.open({ url: h.url });
                onOpen();
              }}
              data-dwell
            >
              <span className="bw-recent-title">{h.title || displayUrl(h.url)}</span>
              <span className="bw-recent-sub">
                {displayUrl(h.url)} ·{" "}
                {new Date(h.at).toLocaleString(undefined, {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </button>
          ))
        )}
      </div>
      <div className="bw-sheet-actions">
        {paged.pages > 1 && (
          <>
            <button className="btn btn-xl" onClick={paged.prev} disabled={paged.page === 0} data-dwell>
              <Icon name="up" size={24} flat /> Newer
            </button>
            <button
              className="btn btn-xl"
              onClick={paged.next}
              disabled={paged.page >= paged.pages - 1}
              data-dwell
            >
              <Icon name="down" size={24} flat /> Older
            </button>
          </>
        )}
        <span className="spacer" />
        {!!items?.length && (
          <button className="btn btn-xl btn-quiet" onClick={() => setConfirm(true)} data-dwell>
            Clear history
          </button>
        )}
      </div>
    </>
  );
}

export function MoreSheet({
  api,
  tab,
  onClose,
}: {
  api: BrowserApi;
  tab: BrowserTab | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<"menu" | "history">("menu");
  const [saved, setSaved] = useState<string | null>(null);
  const addFavourite = async () => {
    if (!tab?.url) return;
    const list = await api.favourites();
    if (list.some((f) => f.url === tab.url)) {
      setSaved("This page is already one of your sites.");
      return;
    }
    const title = (tab.title || displayUrl(tab.url)).slice(0, 40);
    const next = await api.setFavourites([
      ...list,
      { id: `fav-${Date.now().toString(36)}`, title, url: tab.url },
    ]);
    setSaved(
      next.some((f) => f.url === tab.url) ? `Added “${title}” to your sites.` : "That couldn't be added.",
    );
  };
  return (
    <SheetFrame title="More" onEscape={onClose} wide>
      {view === "history" ? (
        <HistoryList api={api} onOpen={onClose} />
      ) : (
        <>
          <h2 className="bw-sheet-title">More</h2>
          {tab?.url && (
            <div className="bw-zoomrow" role="group" aria-label="Page size">
              <button className="bw-option" onClick={() => void api.zoom(tab.id, "out")} data-dwell>
                <Icon name="zoom-out" size={26} flat /> Smaller page
              </button>
              <span className="bw-zoomvalue">{Math.round(tab.zoom * 100)}%</span>
              <button className="bw-option" onClick={() => void api.zoom(tab.id, "in")} data-dwell>
                <Icon name="zoom-in" size={26} flat /> Bigger page
              </button>
              <button className="bw-option" onClick={() => void api.zoom(tab.id, "reset")} data-dwell>
                Actual size
              </button>
            </div>
          )}
          <div className="bw-sheet-options" data-count={3}>
            <button className="bw-option" onClick={() => setView("history")} data-dwell>
              <Icon name="clock" size={26} flat /> History
            </button>
            {tab?.url && (
              <button className="bw-option" onClick={() => void addFavourite()} data-dwell>
                <Icon name="star" size={26} flat /> Add to my sites
              </button>
            )}
            <button
              className="bw-option"
              onClick={() => {
                onClose();
                navigate("/settings/browser");
              }}
              data-dwell
            >
              <Icon name="gear" size={26} flat /> Settings for a helper
            </button>
          </div>
          {saved && (
            <p className="bw-sheet-text" role="status">
              {saved}
            </p>
          )}
        </>
      )}
      <div className="bw-sheet-actions">
        <button
          className="btn btn-xl"
          onClick={view === "menu" ? onClose : () => setView("menu")}
          data-dwell
          data-autofocus
        >
          <Icon name="back" /> {view === "menu" ? "Back to the page" : "Back"}
        </button>
      </div>
    </SheetFrame>
  );
}
