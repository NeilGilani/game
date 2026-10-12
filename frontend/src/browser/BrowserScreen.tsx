/**
 * AGENCY Browser: the web, made to be used with the eyes. The shell draws every control as a big target around the
 * page; the Mac app shows the live page in the middle (main's WebContentsView, placed where `#bw-viewport` is).
 *
 * The page itself is for reading: nothing on it is chosen by looking at it, so reading never clicks anything.
 * To choose, the person looks at "Choose on page" (big numbered labels on everything that can be chosen, the page
 * held still) or "Zoom to choose" (a lens over a part of the page). Scrolling is a look at the scroll zones (or a
 * squint). A text box opens the eye keyboard. "Ask AGENCY" hands the page to the assistant, under the same guard
 * and approvals as everywhere else. Help and Stop (the dock) and Lifeline always stay above the page: the page is
 * hidden whenever anything AGENCY shows would be covered by it.
 */
import "./browser.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { useInput } from "../state/input";
import { navigate, type Route } from "../state/router";
import { AskPanel } from "./AskPanel";
import { AddressOverlay } from "./Address";
import { ChooseLayer, ZoomLayer, ZoomRail, type ChooseView } from "./Choose";
import type { Lens } from "./magnifier";
import { FormPanel } from "./FormPanel";
import { Reader } from "./Reader";
import { ScrollZone } from "./ScrollZone";
import { ConfirmSheet, ListSheet, MoreSheet, PopupSheet, PromptSheet } from "./Sheets";
import { BrowserFallback, ErrorPage, StartPage } from "./StartPage";
import {
  browserApi,
  clearField,
  dismissNotice,
  useBrowserSnapshot,
  type BrowserApi,
  type BrowserTab,
  type ConsequentialKind,
  type PageField,
  type PageFrame,
  type PopupInfo,
} from "./store";
import { TabsOverlay } from "./Tabs";
import { displayUrl } from "./omnibox";
import { registerScroller } from "../input/SquintScroll";

export type Mode = "live" | "choose" | "zoom" | "reader" | "tabs" | "address";

export type Sheet =
  | {
      type: "confirm";
      ref: string | null;
      field: boolean;
      action: ConsequentialKind;
      label: string;
      origin: string;
    }
  | { type: "list"; ref: string; label: string; options: string[]; selected: string | null }
  | { type: "popup"; info: PopupInfo | null }
  | { type: "more" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function BrowserScreen({ route }: { route: Route }) {
  const api = browserApi();
  if (!api) return <BrowserFallback />;
  return <BrowserApp key="browser" api={api} taskParam={route.query.get("task")} />;
}

/** True while AGENCY shows a dialog anywhere (Lifeline, an approval): the page must not cover it. */
function useModalOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(!!document.querySelector('[data-dwell-scope="modal"], .lifeline-overlay'));
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return open;
}

/**
 * Tells main where the page goes: the viewport's rectangle (minus the eye keyboard, which must never be covered)
 * and whether it may show. Checked on resize and a few times a second, sent only when it changes.
 */
function useViewportLayout(api: BrowserApi, el: React.RefObject<HTMLDivElement | null>, visible: boolean) {
  const last = useRef("");
  useLayoutEffect(() => {
    const send = () => {
      const node = el.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      let height = r.height;
      // The eye keyboard and the typing bar above it must never be covered by the page.
      for (const sel of [".eye-keyboard", ".bw-formbar"]) {
        const el2 = document.querySelector(sel);
        if (el2) height = Math.min(height, el2.getBoundingClientRect().top - r.top - 12);
      }
      const ok = visible && r.width > 80 && height > 120;
      const rect = { x: r.left, y: r.top, width: r.width, height: Math.max(0, height) };
      const key = JSON.stringify([
        ok,
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.width),
        Math.round(rect.height),
      ]);
      if (key === last.current) return;
      last.current = key;
      api.layout(ok ? rect : null, ok);
    };
    send();
    const ro = new ResizeObserver(send);
    if (el.current) ro.observe(el.current);
    window.addEventListener("resize", send);
    const t = window.setInterval(send, 300);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", send);
      window.clearInterval(t);
    };
  }, [api, el, visible]);
  // Leaving the browser screen hides the page.
  useEffect(
    () => () => {
      last.current = "";
      api.layout(null, false);
    },
    [api],
  );
}

function securityChip(tab: BrowserTab | null) {
  if (!tab || tab.security === "new") return null;
  if (tab.security === "secure") return <Icon name="lock" size={22} flat />;
  if (tab.security === "local") return <Icon name="laptop" size={22} flat />;
  return <Icon name="alert" size={22} flat />;
}

function BrowserApp({ api, taskParam }: { api: BrowserApi; taskParam: string | null }) {
  const snap = useBrowserSnapshot();
  const announce = useAnnounce();
  const input = useInput();
  const state = snap.state;
  const tab = state?.tabs.find((t) => t.id === state.activeId) ?? null;
  const [mode, setMode] = useState<Mode>("live");
  const [frame, setFrame] = useState<PageFrame | null>(null);
  const [chooseView, setChooseView] = useState<ChooseView>({ set: 0, only: null });
  const [lens, setLens] = useState<Lens | null>(null);
  const [form, setForm] = useState<{ tabId: number; field: PageField } | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [taskId, setTaskId] = useState<string | null>(taskParam);
  const [askOpen, setAskOpen] = useState(!!taskParam);
  const [askGoal, setAskGoal] = useState<{ text: string; n: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const modal = useModalOpen();
  const viewport = useRef<HTMLDivElement>(null);
  const hasPage = !!tab?.url && !tab.error;
  const big = !!state?.bigScreen;
  const live = mode === "live" && !sheet && !modal && hasPage && snap.prompts.length === 0;
  useViewportLayout(api, viewport, live);

  useEffect(() => {
    if (taskParam) {
      setTaskId(taskParam);
      setAskOpen(true);
    }
  }, [taskParam]);

  // A new screen of choices: a lingering look must not pick one.
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, [mode, sheet?.type, form?.field.ref]);

  // Another tab or page: drop the held picture and anything about the old page.
  const pageKey = `${tab?.id}:${tab?.url}`;
  const lastPage = useRef(pageKey);
  useEffect(() => {
    if (lastPage.current === pageKey) return;
    lastPage.current = pageKey;
    if (mode === "choose" || mode === "zoom") setMode("live");
    setFrame(null);
    setForm((f) => (f && f.tabId === tab?.id ? f : null));
  }, [pageKey, mode, tab?.id]);

  // The person clicked into a text box on the page: the eye keyboard, unless they are using a mouse and keyboard.
  useEffect(() => {
    if (!snap.field || !tab || snap.field.tabId !== tab.id) return;
    if (input.mode !== "pointer") setForm({ tabId: tab.id, field: snap.field.field });
    clearField();
  }, [snap.field, tab, input.mode]);

  // Squint-to-scroll over the page scrolls the page.
  useEffect(() => {
    const el = viewport.current;
    if (!el || !tab) return;
    return registerScroller(el, (dy) => api.scroll(tab.id, { by: "px", amount: dy }));
  }, [api, tab]);

  const say = useCallback((text: string) => announce(text), [announce]);

  const refreshFrame = useCallback(
    async (next: "choose" | "zoom") => {
      if (!tab || !hasPage) return;
      setBusy("Getting the page ready…");
      if (mode !== "live") {
        // The picture must be of the page as it is now: show it for a moment first.
        setMode("live");
        await sleep(450);
      }
      const f = await api.frame(tab.id).catch(() => null);
      setBusy(null);
      if (!f) {
        say("This page can't be chosen from right now.");
        setMode("live");
        return;
      }
      setFrame(f);
      setChooseView({ set: 0, only: null });
      setLens(null);
      setMode(next);
      say(
        next === "choose"
          ? f.targets.length
            ? `${f.targets.length} things to choose. Look at a number.`
            : "Nothing to choose here. Try scrolling."
          : "Look at the part of the page you want to choose from.",
      );
    },
    [api, tab, hasPage, mode, say],
  );

  const activate = useCallback(
    async (ref: string, confirmed = false) => {
      if (!tab) return;
      setSheet(null);
      const r = await api
        .activate(tab.id, ref, confirmed)
        .catch(() => ({ kind: "error" as const, message: "That didn't work." }));
      if (r.kind === "done") {
        setMode("live");
        setFrame(null);
        say(r.navigated ? "Opening." : "Done.");
      } else if (r.kind === "field") {
        setMode("live");
        setFrame(null);
        setForm({ tabId: tab.id, field: r.field });
      } else if (r.kind === "list") {
        setSheet({ type: "list", ref: r.ref, label: r.label, options: r.options, selected: r.selected });
      } else if (r.kind === "confirm") {
        setSheet({ type: "confirm", ref, field: false, action: r.action, label: r.label, origin: r.origin });
      } else if (r.kind === "gone") {
        say("That isn't on the page any more.");
        await refreshFrame(mode === "zoom" ? "zoom" : "choose");
      } else {
        say(r.message);
        setMode("live");
      }
    },
    [api, tab, say, refreshFrame, mode],
  );

  const scrollBy = useCallback(
    (amount: number) => {
      if (!tab || !hasPage) return;
      api.scroll(tab.id, { by: "px", amount });
    },
    [api, tab, hasPage],
  );
  const page = useCallback(
    async (direction: 1 | -1) => {
      if (!tab || !hasPage) return;
      api.scroll(tab.id, { by: "page", direction });
      if (mode === "choose" || mode === "zoom") {
        await sleep(350);
        await refreshFrame(mode);
      }
    },
    [api, tab, hasPage, mode, refreshFrame],
  );

  const openPopupSheet = async () => {
    if (!tab) return;
    setSheet({ type: "popup", info: await api.popup(tab.id) });
  };

  const openTabs = async () => {
    // A picture of the page for its card, while it is still showing.
    await api.thumbnails().catch(() => undefined);
    setMode("tabs");
  };
  const goStart = () => {
    if (!tab) return;
    setMode("live");
    if (tab.url) void api.start(tab.id);
  };

  if (!state) {
    return (
      <div className="bw bw-loading" aria-busy="true">
        <p className="muted">Opening AGENCY Browser…</p>
      </div>
    );
  }

  const agentHere = snap.agent.active && snap.agent.tabId === tab?.id;
  const strip = agentHere ? (
    <div className="bw-strip bw-strip-agent" role="status">
      <Icon name="sparkle" size={22} flat />
      <span>
        <strong>AGENCY is working on this page.</strong>{" "}
        {snap.agent.acting ?? "It will ask you before anything important."}
      </span>
    </div>
  ) : snap.agent.helperNeeded && snap.agent.tabId === tab?.id ? (
    <div className="bw-strip bw-strip-warn" role="alert">
      <Icon name="hand" size={22} flat />
      <span>{snap.agent.helperNeeded}</span>
    </div>
  ) : snap.notices.length ? (
    <div className={`bw-strip bw-strip-${snap.notices.at(-1)!.tone}`} role="status">
      <Icon name={snap.notices.at(-1)!.tone === "info" ? "info" : "alert"} size={22} flat />
      <span>{snap.notices.at(-1)!.text}</span>
      <button
        className="bw-strip-close"
        onClick={() => dismissNotice(snap.notices.at(-1)!.id)}
        data-dwell
        aria-label="Close this message"
      >
        <Icon name="x" size={22} />
      </button>
    </div>
  ) : tab?.security === "insecure" ? (
    <div className="bw-strip bw-strip-warn" role="status">
      <Icon name="alert" size={22} flat />
      <span>
        <strong>Not secure.</strong> This page isn't private: don&apos;t type passwords, card numbers or
        personal details here.
      </span>
    </div>
  ) : null;

  const prompt = snap.prompts[0];

  return (
    <div
      className="bw"
      data-mode={mode}
      data-big={big || undefined}
      data-ask={askOpen || undefined}
      data-form={form ? "" : undefined}
      aria-label="AGENCY Browser"
    >
      {big ? (
        <div className="bw-bigbar" role="group" aria-label="Big screen">
          <button className="bw-tool" onClick={() => api.exitBigScreen()} data-dwell>
            <Icon name="x" size={26} />
            <span>Exit big screen</span>
          </button>
          {tab?.video && (
            <>
              <button className="bw-tool" onClick={() => void api.video(tab.id, "back")} data-dwell>
                <Icon name="left" size={26} />
                <span>Back 10 s</span>
              </button>
              <button
                className="bw-tool bw-tool-primary"
                onClick={() => void api.video(tab.id, "play-pause")}
                data-dwell
              >
                <Icon name={tab.video.playing ? "pause" : "play"} size={26} flat />
                <span>{tab.video.playing ? "Pause" : "Play"}</span>
              </button>
              <button className="bw-tool" onClick={() => void api.video(tab.id, "forward")} data-dwell>
                <Icon name="right" size={26} />
                <span>Forward 10 s</span>
              </button>
            </>
          )}
        </div>
      ) : (
        <header className="bw-toolbar" role="group" aria-label="Browser controls">
          <button
            className="bw-tool"
            onClick={() => tab && void api.back(tab.id)}
            disabled={!tab || (!tab.canGoBack && !tab.url)}
            data-dwell
          >
            <Icon name="left" size={28} />
            <span>Back</span>
          </button>
          <button
            className="bw-tool"
            onClick={() => tab && void api.forward(tab.id)}
            disabled={!tab?.canGoForward}
            data-dwell
          >
            <Icon name="right" size={28} />
            <span>Forward</span>
          </button>
          {tab?.loading ? (
            <button className="bw-tool" onClick={() => void api.stopLoading(tab.id)} data-dwell>
              <Icon name="x" size={28} />
              <span>Stop loading</span>
            </button>
          ) : (
            <button
              className="bw-tool"
              onClick={() => tab && void api.reload(tab.id)}
              disabled={!tab?.url}
              data-dwell
            >
              <Icon name="refresh" size={26} flat />
              <span>Reload</span>
            </button>
          )}
          <button className="bw-tool" onClick={goStart} disabled={!tab?.url} data-dwell>
            <Icon name="grid" size={26} flat />
            <span>Start page</span>
          </button>
          <button
            className="bw-address"
            onClick={() => setMode("address")}
            data-dwell
            data-security={tab?.security}
            aria-label={
              tab?.url
                ? `Address: ${displayUrl(tab.url)}. Look here to go somewhere else or search.`
                : "Search or type a web address"
            }
          >
            <span className="bw-address-icon" aria-hidden>
              {securityChip(tab) ?? <Icon name="search" size={24} flat />}
            </span>
            <span className="bw-address-text">
              {tab?.url ? (
                <>
                  <span className="bw-address-host">
                    {displayUrl(tab.url)}
                    {tab.security === "insecure" && <span className="bw-badge-warn">Not secure</span>}
                  </span>
                  <span className="bw-address-title">{tab.loading ? "Loading…" : tab.title}</span>
                </>
              ) : (
                <span className="bw-address-host bw-address-placeholder">Search or type a web address</span>
              )}
            </span>
            <span className="bw-address-go" aria-hidden>
              <Icon name="edit" size={22} flat />
            </span>
          </button>
          <button
            className="bw-tool"
            onClick={() => void openTabs()}
            data-dwell
            aria-label={`Tabs: ${state.tabs.length} open`}
          >
            <span className="bw-tabcount" aria-hidden>
              {state.tabs.length}
            </span>
            <span>Tabs</span>
          </button>
          <button
            className="bw-tool bw-ask"
            onClick={() => setAskOpen((o) => !o)}
            aria-pressed={askOpen}
            data-dwell
          >
            <Icon name="sparkle" size={26} flat />
            <span>{askOpen ? "Close AGENCY" : "Ask AGENCY"}</span>
          </button>
        </header>
      )}

      {!big && (
        <nav className="bw-left" aria-label="Page">
          {mode === "choose" && frame ? (
            <ChooseLayer.List
              frame={frame}
              view={chooseView}
              onView={setChooseView}
              onPick={(ref) => void activate(ref)}
              onDone={() => setMode("live")}
            />
          ) : mode === "zoom" && frame ? (
            <ZoomRail lens={lens} onCloseLens={() => setLens(null)} onDone={() => setMode("live")} />
          ) : (
            <>
              <button
                className="bw-rail-btn bw-rail-primary"
                onClick={() => void refreshFrame("choose")}
                disabled={!hasPage}
                data-dwell
              >
                <Icon name="labels" size={34} flat />
                <span>Choose on page</span>
              </button>
              <button
                className="bw-rail-btn"
                onClick={() => void refreshFrame("zoom")}
                disabled={!hasPage}
                data-dwell
              >
                <Icon name="zoom-in" size={34} flat />
                <span>Zoom to choose</span>
              </button>
              <button
                className="bw-rail-btn"
                onClick={() => setMode("reader")}
                disabled={!hasPage}
                data-dwell
              >
                <Icon name="book" size={34} flat />
                <span>Reader view</span>
              </button>
              <button
                className="bw-rail-btn"
                onClick={() => void openPopupSheet()}
                disabled={!hasPage}
                data-dwell
              >
                <Icon name="popup" size={34} flat />
                <span>Close pop-up</span>
              </button>
              <button className="bw-rail-btn" onClick={() => setSheet({ type: "more" })} data-dwell>
                <Icon name="more" size={34} flat />
                <span>More</span>
              </button>
            </>
          )}
        </nav>
      )}

      <div className="bw-center">
        {!big && strip}
        <div
          className="bw-viewport"
          id="bw-viewport"
          ref={viewport}
          data-live={live || undefined}
          aria-label={tab?.url ? `Web page: ${tab.title}` : "Start page"}
        >
          {!tab?.url ? (
            <StartPage api={api} onAddress={() => setMode("address")} onAsk={() => setAskOpen(true)} />
          ) : tab.error ? (
            <ErrorPage tab={tab} api={api} />
          ) : mode === "choose" && frame ? (
            <ChooseLayer frame={frame} view={chooseView} onPick={(ref) => void activate(ref)} />
          ) : mode === "zoom" && frame ? (
            <ZoomLayer frame={frame} lens={lens} onLens={setLens} onPick={(ref) => void activate(ref)} />
          ) : !live && frame?.image ? (
            <img className="bw-still" src={frame.image} alt="" />
          ) : null}
          {busy && (
            <div className="bw-busy" role="status">
              {busy}
            </div>
          )}
        </div>
        {!big && tab?.video && hasPage && mode === "live" && (
          <div className="bw-videobar" role="group" aria-label="Video">
            <button className="bw-tool" onClick={() => void api.video(tab.id, "back")} data-dwell>
              <Icon name="left" size={26} />
              <span>Back 10 s</span>
            </button>
            <button
              className="bw-tool bw-tool-primary"
              onClick={() => void api.video(tab.id, "play-pause")}
              data-dwell
            >
              <Icon name={tab.video.playing ? "pause" : "play"} size={26} flat />
              <span>{tab.video.playing ? "Pause" : "Play"}</span>
            </button>
            <button className="bw-tool" onClick={() => void api.video(tab.id, "forward")} data-dwell>
              <Icon name="right" size={26} />
              <span>Forward 10 s</span>
            </button>
            {tab.video.captions && (
              <button
                className="bw-tool"
                onClick={() => void api.video(tab.id, "captions")}
                aria-pressed={tab.video.captions === "on"}
                data-dwell
              >
                <Icon name="captions" size={26} flat />
                <span>Captions {tab.video.captions === "on" ? "on" : "off"}</span>
              </button>
            )}
            <button className="bw-tool" onClick={() => void api.video(tab.id, "big-screen")} data-dwell>
              <Icon name="expand" size={26} flat />
              <span>Big screen</span>
            </button>
          </div>
        )}
      </div>

      {!big && !askOpen && (
        <nav className="bw-right" aria-label="Scroll the page">
          <ScrollZone direction={-1} onScroll={scrollBy} disabled={!hasPage} />
          <button className="bw-rail-btn" onClick={() => void page(-1)} disabled={!hasPage} data-dwell>
            <Icon name="page-up" size={34} flat />
            <span>Page up</span>
          </button>
          <button className="bw-rail-btn" onClick={() => void page(1)} disabled={!hasPage} data-dwell>
            <Icon name="page-down" size={34} flat />
            <span>Page down</span>
          </button>
          <ScrollZone direction={1} onScroll={scrollBy} disabled={!hasPage} />
        </nav>
      )}

      {!big && askOpen && (
        <AskPanel
          tab={tab}
          taskId={taskId}
          goal={askGoal}
          onTask={(id) => {
            setTaskId(id);
            if (id) navigate(`/internet?task=${encodeURIComponent(id)}`);
            else navigate("/internet");
          }}
          onClose={() => setAskOpen(false)}
        />
      )}

      {form && (
        <FormPanel
          api={api}
          form={form}
          onField={(f) => setForm({ tabId: form.tabId, field: f })}
          onConfirm={(action) =>
            setSheet({
              type: "confirm",
              ref: form.field.ref,
              field: true,
              action,
              label: form.field.submitLabel ?? "Submit",
              origin: displayUrl(tab?.url ?? ""),
            })
          }
          onDone={(navigated) => {
            setForm(null);
            if (navigated) say("Sent.");
          }}
        />
      )}

      {mode === "reader" && tab && <Reader api={api} tab={tab} onClose={() => setMode("live")} />}
      {mode === "tabs" && <TabsOverlay api={api} state={state} onClose={() => setMode("live")} />}
      {mode === "address" && (
        <AddressOverlay
          api={api}
          tab={tab}
          onClose={() => setMode("live")}
          onAsk={(goal) => {
            setMode("live");
            setAskOpen(true);
            setAskGoal((g) => ({ text: goal, n: (g?.n ?? 0) + 1 }));
          }}
        />
      )}

      {prompt ? (
        <PromptSheet api={api} prompt={prompt} />
      ) : sheet?.type === "confirm" ? (
        <ConfirmSheet
          sheet={sheet}
          onYes={() => {
            if (sheet.field && form && tab) {
              setSheet(null);
              void api.field(tab.id, form.field.ref, { op: "submit", confirmed: true }).then((r) => {
                if (r.kind === "done") setForm(null);
              });
            } else if (sheet.ref) void activate(sheet.ref, true);
          }}
          onNo={() => setSheet(null)}
        />
      ) : sheet?.type === "list" && tab ? (
        <ListSheet
          sheet={sheet}
          onPick={(option) => {
            setSheet(null);
            setMode("live");
            void api
              .chooseOption(tab.id, sheet.ref, option)
              .then((ok) => say(ok ? `Chose ${option}.` : "That didn't work."));
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet?.type === "popup" && tab ? (
        <PopupSheet
          info={sheet.info}
          onChoose={(ref) => {
            setSheet(null);
            void api.closePopup(tab.id, ref).then((ok) => say(ok ? "Done." : "That didn't work."));
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet?.type === "more" ? (
        <MoreSheet api={api} tab={tab} onClose={() => setSheet(null)} />
      ) : null}
    </div>
  );
}
