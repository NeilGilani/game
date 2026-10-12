/**
 * Going somewhere: a big box the eye keyboard types into, and big suggestions as the person types (go to the
 * address, search, ask AGENCY, favourites and recent pages). The eye keyboard's Done goes to the first suggestion.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { parseOmnibox, suggestions, type SearchEngine, type Suggestion } from "./omnibox";
import type { BrowserApi, BrowserTab, Favourite, HistoryEntry } from "./store";

const ICON: Record<Suggestion["kind"], string> = {
  open: "globe",
  search: "search",
  ask: "sparkle",
  history: "clock",
  favourite: "star",
};

export function AddressOverlay({
  api,
  tab,
  onClose,
  onAsk,
}: {
  api: BrowserApi;
  tab: BrowserTab | null;
  onClose: () => void;
  onAsk: (goal: string) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<SearchEngine>("google");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void api.settings().then(
      (s) => live && setEngine(s.searchEngine),
      () => undefined,
    );
    void api.history().then(
      (h) => live && setHistory(h.slice(0, 50)),
      () => undefined,
    );
    void api.favourites().then(
      (f) => live && setFavourites(f),
      () => undefined,
    );
    input.current?.focus();
    return () => {
      live = false;
    };
  }, [api]);

  const list = useMemo(
    () => suggestions(text, { engine, history, favourites, limit: 4 }),
    [text, engine, history, favourites],
  );

  const choose = (s: Suggestion) => {
    if (s.kind === "ask") {
      onAsk(s.value);
      return;
    }
    const go = tab ? api.navigate(tab.id, s.value) : api.open({ url: s.value });
    void go.then((r) => (r.ok ? onClose() : setError(r.error)));
  };

  const submit = () => {
    const r = parseOmnibox(text, engine);
    if (r.kind === "blocked") setError(r.reason);
    else if (r.kind === "url" || r.kind === "search")
      choose({ kind: r.kind === "url" ? "open" : "search", label: "", value: r.url });
  };

  return (
    <div className="bw-overlay bw-address-overlay" role="dialog" aria-label="Go somewhere">
      <div className="bw-overlay-bar">
        <button className="bw-tool" onClick={onClose} data-dwell>
          <Icon name="left" size={26} />
          <span>Back to the page</span>
        </button>
        <form
          className="bw-omnibox"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Icon name="search" size={30} flat />
          <label htmlFor="bw-omnibox-input" className="sr-only">
            Search or type a web address
          </label>
          <input
            id="bw-omnibox-input"
            ref={input}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            placeholder="Search or type a web address"
            autoComplete="off"
            spellCheck={false}
          />
          {text && (
            <button
              type="button"
              className="bw-omnibox-clear"
              onClick={() => setText("")}
              data-dwell
              aria-label="Clear"
            >
              <Icon name="x" size={24} />
            </button>
          )}
        </form>
      </div>
      {error && (
        <p className="bw-address-error" role="alert">
          <Icon name="alert" size={22} flat /> {error}
        </p>
      )}
      <div className="bw-suggestions" role="list" aria-label="Suggestions">
        {list.map((s) => (
          <button
            key={`${s.kind}:${s.value}`}
            className="bw-suggestion"
            data-kind={s.kind}
            onClick={() => choose(s)}
            data-dwell
            role="listitem"
          >
            <Icon name={ICON[s.kind]} size={28} flat />
            <span className="bw-suggestion-label">{s.label}</span>
            {s.sub && <span className="bw-suggestion-sub">{s.sub}</span>}
          </button>
        ))}
        {!text && list.length === 0 && (
          <p className="muted">Look at the letters on the eye keyboard to type.</p>
        )}
      </div>
    </div>
  );
}
