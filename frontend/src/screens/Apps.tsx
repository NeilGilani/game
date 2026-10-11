/**
 * Mac apps: switch to an open one or open another, through agency-native. Eight big tiles a page, never scrolled.
 * In a browser the list is a simulated example and opening only pretends, and the screen says so.
 */
import { useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import type { AppInfo } from "../state/contracts";
import { memory } from "../state/memory";
import { apps } from "../state/native";
import { navigate, type Route } from "../state/router";

const PER_PAGE = 8;

function AppIcon({ app }: { app: AppInfo }) {
  if (app.iconPng) return <img className="app-icon" src={`data:image/png;base64,${app.iconPng}`} alt="" />;
  return (
    <span className="app-icon app-icon-letter" aria-hidden>
      {app.name.replace(/^Google /, "").charAt(0)}
    </span>
  );
}

export function AppsScreen({ route }: { route: Route }) {
  const view = route.query.get("view") === "all" ? "all" : "running";
  const announce = useAnnounce();
  const [list, setList] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    apps()
      .list()
      .then((a) => setList([...a].sort((x, y) => x.name.localeCompare(y.name))))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't list apps."));
  useEffect(() => {
    void load();
  }, []);

  const shown = (list ?? []).filter((a) => (view === "running" ? a.running : true));
  const paged = usePaged(shown, PER_PAGE);

  const open = async (app: AppInfo) => {
    void memory().record({ path: ["apps", app.name], surface: "apps", outcome: "chosen" });
    const r = app.running ? await apps().activate(app.bundleId) : await apps().launch(app.bundleId);
    const text = r.ok
      ? `${app.name} is ${app.running ? "in front" : "open"}${apps().simulated ? " (simulated in the browser)" : ""}.`
      : `Couldn't open ${app.name}.`;
    setNotice(text);
    announce(text);
    void load();
  };

  return (
    <div className="flow apps-flow" aria-label="Apps">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="grid" size={18} /> Apps
          {apps().simulated && (
            <span className="badge" data-tone="sim">
              Simulated: example apps
            </span>
          )}
        </div>
        <h1 id="flow-prompt" tabIndex={-1}>
          {view === "running" ? "Switch to an open app" : "Open an app"}
        </h1>
        <p className="muted" role="status">
          {notice ??
            (apps().simulated
              ? "In the AGENCY Mac app these are your real apps. A web page can't open Mac apps."
              : "Your eyes work inside every app: look at a button to press it.")}
        </p>
      </div>

      {error ? (
        <p className="panel panel-danger">{error}</p>
      ) : list === null ? (
        <div className="flow-options flow-waiting" aria-busy="true">
          <p className="muted">Finding your apps…</p>
        </div>
      ) : (
        <div className="apps-grid" role="group" aria-label={view === "running" ? "Open apps" : "All apps"}>
          {paged.items.map((app) => (
            <button key={app.bundleId} className="app-tile" onClick={() => void open(app)} data-dwell>
              <AppIcon app={app} />
              <span className="app-name">{app.name}</span>
              <span className="app-state">
                {app.frontmost ? "In front" : app.running ? "Open: switch to it" : "Open it"}
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="muted">No apps are open.</p>}
        </div>
      )}

      <div className="flow-bar" role="group" aria-label="Move around">
        <button className="btn btn-xl" onClick={() => navigate("/flow/apps")} data-dwell>
          <Icon name="back" /> Back
        </button>
        <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
        <button
          className="btn btn-xl"
          onClick={() => navigate(view === "running" ? "/apps?view=all" : "/apps?view=running")}
          data-dwell
        >
          <Icon name="grid" /> {view === "running" ? "All apps" : "Open apps"}
        </button>
        <span className="spacer" />
        {paged.pages > 1 && (
          <>
            <button className="btn btn-xl" onClick={paged.prev} disabled={paged.page === 0} data-dwell>
              <Icon name="left" /> Previous
            </button>
            <span className="muted">
              {paged.page + 1} of {paged.pages}
            </span>
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
    </div>
  );
}
