/**
 * Settings, For a helper, AGENCY Browser: the start page's sites, search, ad blocking, what the assistant may do on
 * websites, site permissions, and clearing history or signing out. Main checks and stores all of it
 * (main/browser/store.ts) and writes the assistant's limits for the agent's guard (main/browser/agentweb.ts).
 */
import "./browser.css";
import { useEffect, useState } from "react";
import { ConfirmSheet } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { Toggle } from "../screens/SettingsViews";
import { forgetTyped } from "./FormPanel";
import { displayUrl, engineName, parseOmnibox, type SearchEngine } from "./omnibox";
import { SiteMark } from "./StartPage";
import {
  browserApi,
  rememberSettings,
  type BrowserSettings as Settings,
  type Favourite,
  type SitePermissionEntry,
} from "./store";

const ENGINES: SearchEngine[] = ["google", "duckduckgo", "bing"];
const PERMISSION_NAMES: Record<string, string> = {
  location: "Location",
  microphone: "Microphone",
  notifications: "Notifications",
  clipboard: "Reading copied text",
  camera: "Camera",
};

export function BrowserSettings() {
  const api = browserApi();
  const announce = useAnnounce();
  const [s, setS] = useState<Settings | null>(null);
  const [favs, setFavs] = useState<Favourite[]>([]);
  const [perms, setPerms] = useState<SitePermissionEntry[]>([]);
  const [title, setTitle] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"real" | "history" | "signout" | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.settings().then(setS, () => undefined);
    void api.favourites().then(setFavs, () => undefined);
    void api.sitePermissions().then(setPerms, () => undefined);
  }, [api]);

  const say = (text: string) => {
    setNote(text);
    announce(text);
  };
  const change = async (patch: Partial<Settings>, text: string) => {
    if (!api) return;
    const next = await api.setSettings(patch);
    setS(next);
    rememberSettings(next);
    say(text);
  };
  const addSite = async () => {
    if (!api) return;
    const r = parseOmnibox(address);
    if (r.kind !== "url") {
      say(r.kind === "blocked" ? r.reason : "That doesn't look like a web address, for example bbc.co.uk.");
      return;
    }
    const name = title.trim() || displayUrl(r.url);
    const next = await api.setFavourites([
      ...favs,
      { id: `fav-${Date.now().toString(36)}`, title: name, url: r.url },
    ]);
    setFavs(next);
    setTitle("");
    setAddress("");
    say(next.some((f) => f.url === r.url) ? `Added ${name}.` : "That site couldn't be added.");
  };

  if (!api)
    return (
      <Page label="AGENCY Browser">
        <div className="page-head">
          <div>
            <div className="eyebrow">Settings · For a helper</div>
            <h1>AGENCY Browser</h1>
          </div>
        </div>
        <p className="panel" role="note">
          AGENCY Browser is part of the AGENCY Mac app. In a web browser, sites open in a new tab instead.
        </p>
      </Page>
    );

  return (
    <Page label="AGENCY Browser settings">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings · For a helper</div>
          <h1>AGENCY Browser</h1>
          <p>
            The internet made for the eyes. Sign-ins made here stay in AGENCY Browser only. AGENCY never types
            passwords: sign in to sites once for the person, with a keyboard.
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/settings/helper")} data-dwell>
          <Icon name="back" /> For a helper
        </button>
      </div>

      <section className="stack" aria-labelledby="bs-sites">
        <h2 id="bs-sites">
          <Icon name="star" size={24} flat /> Sites on the start page
        </h2>
        <div className="bs-favs">
          {favs.map((f) => (
            <div key={f.id} className="bs-fav">
              <SiteMark title={f.title} size={44} />
              <span className="bs-fav-text">
                <strong>{f.title}</strong>
                <span className="muted small">{displayUrl(f.url)}</span>
              </span>
              <button
                className="btn"
                onClick={() => void api.setFavourites(favs.filter((x) => x.id !== f.id)).then(setFavs)}
                data-dwell
                aria-label={`Remove ${f.title}`}
              >
                <Icon name="x" /> Remove
              </button>
            </div>
          ))}
        </div>
        <form
          className="bs-add"
          onSubmit={(e) => {
            e.preventDefault();
            void addSite();
          }}
        >
          <label className="field">
            <span>Name on the tile</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Grandson's blog"
              maxLength={40}
            />
          </label>
          <label className="field">
            <span>Web address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="example.com"
              autoComplete="off"
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={!address.trim()} data-dwell>
            <Icon name="plus" /> Add site
          </button>
        </form>
      </section>

      {s && (
        <>
          <section className="stack" aria-labelledby="bs-search">
            <h2 id="bs-search">
              <Icon name="search" size={24} flat /> Search with
            </h2>
            <div className="grid grid-3" role="group" aria-labelledby="bs-search">
              {ENGINES.map((e) => (
                <button
                  key={e}
                  className="tile"
                  style={{ minHeight: 100 }}
                  aria-pressed={s.searchEngine === e}
                  onClick={() => void change({ searchEngine: e }, `Searches use ${engineName(e)}.`)}
                  data-dwell
                >
                  <span className="tile-title">{engineName(e)}</span>
                  <span className="tile-check">
                    <Icon name="check" size={22} />
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="stack" aria-labelledby="bs-page">
            <h2 id="bs-page">
              <Icon name="shield" size={24} flat /> Pages
            </h2>
            <div className="grid grid-2">
              <Toggle
                label="Block ads and trackers"
                value={s.blockAds}
                onChange={(on) =>
                  void change(
                    { blockAds: on },
                    on ? "Ads and trackers from a small list are blocked." : "Ads are no longer blocked.",
                  )
                }
                help="Fewer moving things and pop-ups on pages"
              />
            </div>
          </section>

          <section className="stack" aria-labelledby="bs-agent">
            <h2 id="bs-agent">
              <Icon name="sparkle" size={24} flat /> AGENCY&apos;s assistant on websites
            </h2>
            <p className="small muted">
              Whatever is chosen here, the assistant never types passwords, card numbers or codes, stops at
              robot checks and sign-in walls, only reads on banking, health and government sites unless each
              step is approved, and asks before anything that sends, buys, signs, deletes or changes an
              account.
            </p>
            <div className="grid grid-2">
              <Toggle
                label="May open and read any website"
                value={s.agentAnySite}
                onChange={(on) =>
                  void change(
                    { agentAnySite: on },
                    on
                      ? "The assistant may open and read any website."
                      : "The assistant uses the practice sites only.",
                  )
                }
                help={s.agentAnySite ? "Asks before anything important" : "Practice sites only"}
              />
              <Toggle
                label="Real actions, each one approved"
                value={s.realActions}
                onChange={(on) =>
                  on
                    ? setConfirm("real")
                    : void change(
                        { realActions: false },
                        "Real actions are off: the assistant only practises.",
                      )
                }
                help={s.realActions ? "Sends, buys and submits for real after approval" : "Practice only"}
              />
            </div>
            <div className="grid grid-2" role="group" aria-label="Where the assistant works">
              {(["agency", "chrome"] as const).map((b) => (
                <button
                  key={b}
                  className="tile"
                  style={{ minHeight: 100 }}
                  aria-pressed={s.agentBrowser === b}
                  onClick={() =>
                    void change(
                      { agentBrowser: b },
                      b === "agency"
                        ? "Web tasks run in AGENCY Browser."
                        : "Web tasks run in Chrome when the AGENCY extension is connected.",
                    )
                  }
                  data-dwell
                >
                  <span className="tile-title">
                    {b === "agency" ? "Tasks in AGENCY Browser" : "Tasks in my Chrome"}
                  </span>
                  <span className="tile-sub">
                    {b === "agency" ? "You watch each step here" : "Needs the AGENCY extension"}
                  </span>
                  <span className="tile-check">
                    <Icon name="check" size={22} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="stack" aria-labelledby="bs-perms">
        <h2 id="bs-perms">
          <Icon name="hand" size={24} flat /> Sites you answered
        </h2>
        {perms.length === 0 ? (
          <p className="muted">No site has asked yet. AGENCY's camera is never shared with sites.</p>
        ) : (
          <div className="bs-favs">
            {perms.map((p) => (
              <div key={`${p.origin}-${p.permission}`} className="bs-fav">
                <span className="bs-fav-text">
                  <strong>{displayUrl(p.origin)}</strong>
                  <span className="muted small">
                    {PERMISSION_NAMES[p.permission] ?? p.permission}:{" "}
                    {p.decision === "allow" ? "allowed" : "never"}
                  </span>
                </span>
                <button
                  className="btn"
                  onClick={() =>
                    void api
                      .forgetSitePermission(p.origin, p.permission)
                      .then(() => setPerms(perms.filter((x) => x !== p)))
                  }
                  data-dwell
                >
                  Ask again next time
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="stack" aria-labelledby="bs-clear">
        <h2 id="bs-clear">
          <Icon name="clock" size={24} flat /> History and sign-ins
        </h2>
        <div className="btn-row">
          <button className="btn" onClick={() => setConfirm("history")} data-dwell>
            Clear history
          </button>
          <button className="btn btn-danger" onClick={() => setConfirm("signout")} data-dwell>
            Sign out of every site
          </button>
        </div>
      </section>

      {note && (
        <p className="panel" role="status">
          {note}
        </p>
      )}

      {confirm === "real" && (
        <ConfirmSheet
          title="Let the assistant act for real?"
          confirmLabel="Turn on real actions"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void change({ realActions: true }, "Real actions are on. The person approves each one first.");
          }}
        >
          <p>
            The assistant may then send messages, submit forms and buy things for real on websites, each time
            only after the person approves exactly what will happen. Spending limits still apply.
          </p>
        </ConfirmSheet>
      )}
      {confirm === "history" && (
        <ConfirmSheet
          title="Clear history?"
          confirmLabel="Clear history"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            forgetTyped();
            void api.clearHistory().then(() => say("History cleared."));
          }}
        >
          <p>The list of visited pages and typed words in AGENCY Browser is erased from this computer.</p>
        </ConfirmSheet>
      )}
      {confirm === "signout" && (
        <ConfirmSheet
          title="Sign out of every site?"
          confirmLabel="Sign out of everything"
          tone="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void api.clearSiteData().then(() => say("Signed out of every site in AGENCY Browser."));
          }}
        >
          <p>
            Every site's sign-in, cookies and saved data in AGENCY Browser is removed. A helper will need to
            sign in again.
          </p>
        </ConfirmSheet>
      )}
    </Page>
  );
}
