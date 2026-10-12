/**
 * AGENCY Browser's start page (drawn by the shell, not a web page): one big way to search, the favourite sites as
 * big tiles, and the last few pages. Also the page shown when a page can't load, and the web version's stand-in.
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { host } from "../state/host";
import { displayUrl, parseOmnibox } from "./omnibox";
import type { BrowserApi, BrowserTab, Favourite, HistoryEntry } from "./store";

/** The same defaults main starts with (main/browser/store.ts), for the web version. */
export const DEFAULT_FAVOURITES: Favourite[] = [
  { id: "google", title: "Google", url: "https://www.google.com/" },
  { id: "youtube", title: "YouTube", url: "https://www.youtube.com/" },
  { id: "wikipedia", title: "Wikipedia", url: "https://www.wikipedia.org/" },
  { id: "news", title: "News", url: "https://news.google.com/" },
  { id: "weather", title: "Weather", url: "https://weather.com/" },
  { id: "email", title: "Email", url: "https://mail.google.com/" },
];

const TILE_COLOURS = ["#2563eb", "#c2410c", "#047857", "#7c3aed", "#be123c", "#0e7490", "#a16207", "#4338ca"];

/** A site's letter tile, coloured by its name (no icons are fetched from the sites). */
export function SiteMark({ title, size = 72 }: { title: string; size?: number }) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span
      className="bw-sitemark"
      style={{
        width: size,
        height: size,
        background: TILE_COLOURS[h % TILE_COLOURS.length],
        fontSize: size * 0.48,
      }}
      aria-hidden
    >
      {(title.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function StartPage({
  api,
  onAddress,
  onAsk,
}: {
  api: BrowserApi;
  onAddress: () => void;
  onAsk: () => void;
}) {
  const [favourites, setFavourites] = useState<Favourite[] | null>(null);
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    let live = true;
    void api.favourites().then(
      (f) => live && setFavourites(f),
      () => live && setFavourites([]),
    );
    void api.history().then(
      (h) => live && setRecent(h.slice(0, 3)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);
  const open = (url: string) => void api.open({ url });
  return (
    <div className="bw-start">
      <div className="bw-start-head">
        <button className="bw-start-search" onClick={onAddress} data-dwell>
          <Icon name="search" size={34} flat />
          <span>Search or type a web address</span>
        </button>
        <button className="bw-start-ask" onClick={onAsk} data-dwell>
          <Icon name="sparkle" size={30} flat />
          <span>Ask AGENCY to find something</span>
        </button>
      </div>
      <h2 className="bw-start-title">Your sites</h2>
      <div className="bw-tiles" data-count={favourites?.length ?? 6}>
        {(favourites ?? []).map((f) => (
          <button
            key={f.id}
            className="bw-tile"
            onClick={() => open(f.url)}
            data-dwell
            aria-label={`${f.title}: ${displayUrl(f.url)}`}
          >
            <SiteMark title={f.title} />
            <span className="bw-tile-text">
              <span className="bw-tile-title">{f.title}</span>
              <span className="bw-tile-sub">{displayUrl(f.url)}</span>
            </span>
          </button>
        ))}
        {favourites?.length === 0 && (
          <p className="muted">
            No favourite sites yet. A helper can add them in Settings, For a helper, AGENCY Browser.
          </p>
        )}
      </div>
      {recent.length > 0 && (
        <>
          <h2 className="bw-start-title">Lately</h2>
          <div className="bw-recent">
            {recent.map((h) => (
              <button key={h.url} className="bw-recent-item" onClick={() => open(h.url)} data-dwell>
                <Icon name="clock" size={24} flat />
                <span className="bw-recent-title">{h.title || displayUrl(h.url)}</span>
                <span className="bw-recent-sub">{displayUrl(h.url)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ErrorPage({ tab, api }: { tab: BrowserTab; api: BrowserApi }) {
  const e = tab.error!;
  return (
    <div className="bw-error" role="alert">
      <Icon name={e.kind === "certificate" || e.kind === "blocked" ? "shield" : "offline"} size={44} flat />
      <h2>
        {e.kind === "certificate"
          ? "This page isn't safe to open"
          : e.kind === "blocked"
            ? "Blocked"
            : "This page didn't open"}
      </h2>
      <p className="bw-error-text">{e.message}</p>
      <p className="muted">{displayUrl(e.url || tab.url)}</p>
      <div className="bw-error-actions">
        {e.kind !== "certificate" && e.kind !== "blocked" && (
          <button className="btn btn-xl btn-primary" onClick={() => void api.reload(tab.id)} data-dwell>
            <Icon name="refresh" size={26} flat /> Try again
          </button>
        )}
        <button className="btn btn-xl" onClick={() => void api.back(tab.id)} data-dwell>
          <Icon name="left" size={26} /> Back
        </button>
        <button className="btn btn-xl" onClick={() => void api.start(tab.id)} data-dwell>
          <Icon name="grid" size={26} flat /> Start page
        </button>
      </div>
    </div>
  );
}

/**
 * The browser version and the web demo can't show web pages inside AGENCY (a web page can't hold other sites), so
 * the same start page opens sites in a new tab of the person's own browser, and says so.
 */
export function BrowserFallback() {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const open = (url: string, name: string) => {
    const w = window.open(url, "_blank");
    if (w) w.opener = null;
    setNote(
      w === null && !host()
        ? `Your browser blocked the new tab: allow pop-ups to open ${name}.`
        : `${name} is open in a new tab.`,
    );
  };
  return (
    <div className="bw bw-fallback" aria-label="Internet">
      <h1 className="bw-fallback-title">The internet</h1>
      <div className="bw-fallback-note" role="note">
        <Icon name="info" size={24} flat />
        <span>
          In the AGENCY Mac app, the internet opens right here in AGENCY Browser, made for your eyes, with
          AGENCY to help. In a web browser, sites open in a new tab instead.
        </span>
      </div>
      <form
        className="bw-fallback-search"
        onSubmit={(e) => {
          e.preventDefault();
          const r = parseOmnibox(text);
          if (r.kind === "url" || r.kind === "search")
            open(r.url, r.kind === "url" ? displayUrl(r.url) : "Your search");
          else if (r.kind === "blocked") setNote(r.reason);
        }}
      >
        <label className="sr-only" htmlFor="bw-fallback-input">
          Search or type a web address
        </label>
        <input
          id="bw-fallback-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search or type a web address"
          autoComplete="off"
        />
        <button className="btn btn-xl btn-primary" type="submit" disabled={!text.trim()} data-dwell>
          <Icon name="search" size={26} flat /> Go
        </button>
      </form>
      {note && (
        <p className="bw-fallback-status" role="status">
          {note}
        </p>
      )}
      <div className="bw-tiles" data-count={DEFAULT_FAVOURITES.length}>
        {DEFAULT_FAVOURITES.map((f) => (
          <button key={f.id} className="bw-tile" onClick={() => open(f.url, f.title)} data-dwell>
            <SiteMark title={f.title} />
            <span className="bw-tile-text">
              <span className="bw-tile-title">{f.title}</span>
              <span className="bw-tile-sub">{displayUrl(f.url)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
