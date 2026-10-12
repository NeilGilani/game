/** The tab switcher: every open tab as a big card with a picture of its page, a separate big Close, and New tab. */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { displayUrl } from "./omnibox";
import { SiteMark } from "./StartPage";
import type { BrowserApi, BrowserState } from "./store";

export function TabsOverlay({
  api,
  state,
  onClose,
}: {
  api: BrowserApi;
  state: BrowserState;
  onClose: () => void;
}) {
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  useEffect(() => {
    let live = true;
    void api.thumbnails().then(
      (t) => live && setThumbs(t),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, state.tabs.length]);
  const pick = (id: number) => {
    void api.activateTab(id);
    onClose();
  };
  return (
    <div className="bw-overlay bw-tabs" role="dialog" aria-label="Your tabs">
      <div className="bw-overlay-bar">
        <button className="bw-tool" onClick={onClose} data-dwell>
          <Icon name="left" size={26} />
          <span>Back to the page</span>
        </button>
        <h2>
          {state.tabs.length} tab{state.tabs.length === 1 ? "" : "s"} open
        </h2>
        <span className="spacer" />
        <button
          className="bw-tool bw-tool-primary"
          onClick={() => {
            void api.newTab();
            onClose();
          }}
          data-dwell
        >
          <Icon name="plus" size={26} />
          <span>New tab</span>
        </button>
      </div>
      <div className="bw-tabs-grid" data-count={state.tabs.length}>
        {state.tabs.map((t) => (
          <div key={t.id} className="bw-tabcard" data-active={t.id === state.activeId || undefined}>
            <button
              className="bw-tabcard-main"
              onClick={() => pick(t.id)}
              data-dwell
              aria-label={`Go to tab: ${t.url ? t.title : "Start page"}`}
            >
              <span className="bw-tabcard-pic">
                {thumbs[t.id] ? (
                  <img src={thumbs[t.id]} alt="" />
                ) : (
                  <SiteMark title={t.url ? t.title : "Start"} size={64} />
                )}
              </span>
              <span className="bw-tabcard-title">{t.url ? t.title : "Start page"}</span>
              <span className="bw-tabcard-sub">
                {t.agent && <Icon name="sparkle" size={18} flat />}{" "}
                {t.audible && <Icon name="volume" size={18} flat />}{" "}
                {t.url ? displayUrl(t.url) : "Search or choose a site"}
              </span>
            </button>
            <button
              className="bw-tabcard-close"
              onClick={() => void api.closeTab(t.id)}
              data-dwell
              aria-label={`Close tab: ${t.url ? t.title : "Start page"}`}
            >
              <Icon name="x" size={26} />
              <span>Close</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
