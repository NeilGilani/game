/**
 * "What AGENCY knows about me": an eye-operable explorer of the memory tree.
 *
 * Big tiles, paged rather than scrolled, at most about eight choices per screen. Every fact shows
 * why AGENCY believes it, and anything can be kept, hidden, marked private, renamed or forgotten.
 * Forgetting asks first, and the confirm button sits away from where the request was made.
 *
 * Mounted by the shell at #/memory/...; pass the route segments after "memory".
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { lifelineApi } from "../api/client";
import { ConfirmSheet, ErrorNote, SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import { memoryApi, type MemoryApi } from "./api";
import {
  FADE_CHOICES,
  KIND_LABELS,
  capitalize,
  childrenOf,
  dateText,
  detailsText,
  leafCount,
  pageOf,
  relativeDay,
  usualHeadline,
  usualTitle,
} from "./model";
import type { Grant, NodeDetail, Note, Overview, Suggestion, SummaryPreview, TreeNode } from "./types";
import "./memory.css";

const MemoryApiContext = createContext<MemoryApi>(memoryApi);

export function MemoryApiProvider({ api, children }: { api: MemoryApi; children: ReactNode }) {
  return <MemoryApiContext.Provider value={api}>{children}</MemoryApiContext.Provider>;
}

export const useMemoryApi = () => useContext(MemoryApiContext);

const go = (path = "") => navigate(`/memory${path}`);

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}

/** Run an action; report failures in plain words instead of throwing. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

function Pages({
  page,
  pages,
  onPage,
  label,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
  label: string;
}) {
  if (pages <= 1) return null;
  return (
    <div className="mem-pager" role="group" aria-label={`${label} pages`}>
      <button className="btn btn-xl" onClick={() => onPage(page - 1)} disabled={page === 0} data-dwell>
        <Icon name="left" /> Previous
      </button>
      <span className="muted" aria-live="polite">
        Page {page + 1} of {pages}
      </span>
      <button className="btn btn-xl" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} data-dwell>
        Next <Icon name="right" />
      </button>
    </div>
  );
}

function Head({
  eyebrow,
  title,
  children,
  back,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  back?: () => void;
}) {
  return (
    <div className="mem-head">
      {back && (
        <button className="btn btn-xl btn-quiet mem-back" onClick={back} data-dwell>
          <Icon name="back" /> Back
        </button>
      )}
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {children && <p className="mem-lead">{children}</p>}
      </div>
    </div>
  );
}

function Tile({
  title,
  sub,
  icon,
  onSelect,
  pressed,
  tone,
  badge,
}: {
  title: string;
  sub?: string;
  icon: string;
  onSelect: () => void;
  pressed?: boolean;
  tone?: "primary" | "danger";
  badge?: string;
}) {
  return (
    <button
      className={`tile mem-tile${tone === "primary" ? " tile-primary" : ""}${tone === "danger" ? " mem-tile-danger" : ""}`}
      onClick={onSelect}
      aria-pressed={pressed}
      data-dwell
    >
      <span className="tile-icon">
        <Icon name={icon} size={30} />
      </span>
      <span>
        <span className="tile-title">{title}</span>
        {sub && (
          <>
            <br />
            <span className="tile-sub">{sub}</span>
          </>
        )}
      </span>
      {badge && <span className="badge mem-badge">{badge}</span>}
      {pressed !== undefined && (
        <span className="tile-check" aria-hidden="true">
          <Icon name="check" />
        </span>
      )}
    </button>
  );
}

// -- usual card ------------------------------------------------------------------------------
/**
 * "Food, then Usual Friday dinner: Thai Basil, Pad thai (mild). Why: You chose this 4 of your
 * last 5 Friday evenings." with Keep and Forget. Exported for Home and flows to reuse.
 */
export function UsualCard({
  suggestion,
  onChanged,
  now = new Date(),
}: {
  suggestion: Suggestion;
  onChanged?: () => void;
  now?: Date;
}) {
  const api = useMemoryApi();
  const act = useAction();
  const [confirm, setConfirm] = useState(false);
  const [kept, setKept] = useState(suggestion.reason.startsWith("You pinned this."));
  const area = capitalize(suggestion.path[0] ?? "");
  return (
    <section className="panel panel-accent mem-usual" aria-label={`${area}: ${usualTitle(suggestion, now)}`}>
      <div className="eyebrow">
        {area}, then {usualTitle(suggestion, now)}
      </div>
      <h2 className="mem-usual-title">{usualHeadline(suggestion)}</h2>
      <p className="mem-why">
        <strong>Why:</strong> {suggestion.reason}
      </p>
      <div className="mem-actions">
        <button
          className={`btn btn-xl ${kept ? "btn-primary" : ""}`}
          aria-pressed={kept}
          disabled={act.busy}
          data-dwell
          onClick={() =>
            act.run(async () => {
              await api.patch(suggestion.nodeId, { pinned: !kept });
              setKept(!kept);
              onChanged?.();
            })
          }
        >
          <Icon name="check" /> {kept ? "Kept" : "Keep"}
        </button>
        <button
          className="btn btn-xl btn-danger"
          onClick={() => setConfirm(true)}
          disabled={act.busy}
          data-dwell
        >
          <Icon name="x" /> Forget
        </button>
      </div>
      {act.error && <ErrorNote message={act.error} />}
      {confirm && (
        <ConfirmSheet
          title={`Forget ${suggestion.label}?`}
          confirmLabel="Forget it"
          tone="danger"
          busy={act.busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            act.run(async () => {
              await api.forget(suggestion.nodeId);
              setConfirm(false);
              onChanged?.();
            })
          }
        >
          <p>
            AGENCY will forget {suggestion.label} and every time you chose it. It won't be offered again
            unless you choose it again.
          </p>
        </ConfirmSheet>
      )}
    </section>
  );
}

// -- overview --------------------------------------------------------------------------------
function OverviewView() {
  const api = useMemoryApi();
  const tree = useLoad(() => api.tree(), []);
  const overview = useLoad(() => api.overview(), []);
  const [page, setPage] = useState(0);
  const areas = childrenOf(tree.data ?? [], null);
  type Item = { key: string; render: () => ReactNode };
  const items: Item[] = [
    {
      key: "usuals",
      render: () => (
        <Tile
          title="What AGENCY offers first"
          sub="Your usuals, and why"
          icon="sparkle"
          tone="primary"
          onSelect={() => go("/usuals")}
        />
      ),
    },
    ...areas.map((a) => ({
      key: a.id,
      render: () => (
        <Tile
          title={a.masked ? "Private" : capitalize(a.label)}
          sub={`${leafCount(tree.data ?? [], a.id)} thing${leafCount(tree.data ?? [], a.id) === 1 ? "" : "s"}`}
          icon={a.masked || a.effectiveSensitive ? "shield" : "list"}
          badge={a.hidden ? "Hidden" : a.pinned ? "Kept" : a.effectiveSensitive ? "Private" : undefined}
          onSelect={() => go(`/node/${a.id}`)}
        />
      ),
    })),
    {
      key: "privacy",
      render: () => (
        <Tile
          title="Privacy and control"
          sub="Private mode, caregivers, forget"
          icon="shield"
          onSelect={() => go("/privacy")}
        />
      ),
    },
  ];
  const shown = pageOf(items, page, 6);
  const settings = overview.data?.settings;
  return (
    <div className="page mem" aria-label="What AGENCY knows about me">
      <Head eyebrow="Memory" title="What AGENCY knows about me">
        AGENCY remembers what you choose so it can offer it first. It stays on this computer. You can see,
        change or forget any of it.
      </Head>
      {settings && (settings.privateMode || settings.learningPaused) && (
        <div className="mem-status" role="status">
          {settings.privateMode && (
            <span className="chip">
              <Icon name="shield" /> Private mode is on
            </span>
          )}
          {settings.learningPaused && (
            <span className="chip">
              <Icon name="pause" /> Learning is paused
            </span>
          )}
        </div>
      )}
      {tree.error && <ErrorNote message={tree.error} onRetry={tree.reload} />}
      {tree.data && tree.data.length === 0 && (
        <div className="panel panel-muted">
          AGENCY doesn't know anything about you yet. As you choose things, they appear here.
        </div>
      )}
      <div className="grid grid-3 mem-grid">
        {shown.items.map((item) => (
          <div key={item.key} className="mem-cell">
            {item.render()}
          </div>
        ))}
      </div>
      <Pages page={shown.page} pages={shown.pages} onPage={setPage} label="Memory" />
    </div>
  );
}

// -- usuals ----------------------------------------------------------------------------------
function UsualsView() {
  const api = useMemoryApi();
  const list = useLoad(() => api.suggestions("home", 12), []);
  const [page, setPage] = useState(0);
  const shown = pageOf(list.data ?? [], page, 3);
  return (
    <div className="page mem" aria-label="What AGENCY offers first">
      <Head eyebrow="Memory" title="What AGENCY offers first" back={() => go()}>
        These come first on Home right now. Keep the ones you want; forget the ones that are wrong.
      </Head>
      {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && (
        <div className="panel panel-muted">Nothing yet. AGENCY learns as you choose things.</div>
      )}
      <div className="stack mem-stack">
        {shown.items.map((s) => (
          <UsualCard key={s.nodeId} suggestion={s} onChanged={list.reload} />
        ))}
      </div>
      <Pages page={shown.page} pages={shown.pages} onPage={setPage} label="Usuals" />
    </div>
  );
}

// -- one node --------------------------------------------------------------------------------
function NodeView({ id }: { id: string }) {
  const api = useMemoryApi();
  const [reveal, setReveal] = useState(false);
  const detail = useLoad(() => api.node(id, reveal), [id, reveal]);
  const tree = useLoad(() => api.tree(reveal), [id, reveal]);
  const act = useAction();
  const [page, setPage] = useState(0);
  const [sheet, setSheet] = useState<"actions" | "forget" | "rename" | null>(null);
  const [name, setName] = useState("");
  useEffect(() => setPage(0), [id]);

  const node = detail.data;
  const reload = () => {
    detail.reload();
    tree.reload();
  };
  const back = () => go(node?.parentId ? `/node/${node.parentId}` : "");
  if (detail.error) {
    return (
      <div className="page mem">
        <Head eyebrow="Memory" title="Not found" back={() => go()} />
        <ErrorNote message={detail.error} />
      </div>
    );
  }
  if (!node) return <div className="page mem" aria-busy="true" />;
  const kids = childrenOf(tree.data ?? [], id);
  // At most about eight choices on screen: Back, the tiles, paging, and "Change or forget".
  const shown = pageOf(kids, page, node.usual ? 3 : 4);
  const patch = (p: Parameters<MemoryApi["patch"]>[1]) =>
    act.run(async () => {
      await api.patch(id, p);
      reload();
    });

  if (node.masked) {
    return (
      <div className="page mem" aria-label="Private">
        <Head eyebrow="Memory" title="Private" back={back}>
          Private mode keeps health, money and relationships off the screen.
        </Head>
        <div className="mem-actions">
          <button className="btn btn-xl btn-primary" onClick={() => setReveal(true)} data-dwell>
            <Icon name="eye" /> Show it to me
          </button>
        </div>
      </div>
    );
  }

  const actionButtons = (
    <>
      <button
        className={`btn btn-xl${node.pinned ? " btn-primary" : ""}`}
        aria-pressed={node.pinned}
        onClick={() => patch({ pinned: !node.pinned })}
        disabled={act.busy}
        data-dwell
      >
        <Icon name="check" /> {node.pinned ? "Kept" : "Keep"}
      </button>
      <button
        className="btn btn-xl"
        aria-pressed={node.hidden}
        onClick={() => patch({ hidden: !node.hidden })}
        disabled={act.busy}
        data-dwell
      >
        <Icon name="eye" /> {node.hidden ? "Show in suggestions" : "Hide from suggestions"}
      </button>
      <button
        className="btn btn-xl"
        aria-pressed={node.sensitive}
        onClick={() => patch({ sensitive: !node.sensitive })}
        disabled={act.busy}
        data-dwell
      >
        <Icon name="shield" /> {node.sensitive ? "Not private" : "Mark private"}
      </button>
      <button
        className="btn btn-xl"
        onClick={() => {
          setName(node.label);
          setSheet("rename");
        }}
        disabled={act.busy}
        data-dwell
      >
        <Icon name="edit" /> Rename
      </button>
      <button
        className="btn btn-xl btn-danger"
        onClick={() => setSheet("forget")}
        disabled={act.busy}
        data-dwell
      >
        <Icon name="x" /> Forget this
      </button>
    </>
  );
  return (
    <div className="page mem" aria-label={node.label}>
      <Head
        eyebrow={node.path.slice(0, -1).map(capitalize).join(" › ") || "Memory"}
        title={capitalize(node.label)}
        back={back}
      >
        {KIND_LABELS[node.kind]}
        {node.effectiveSensitive ? " · Private" : ""}
        {node.effectiveHidden ? " · Hidden from suggestions" : ""}
      </Head>

      {node.usual && <UsualCard suggestion={node.usual} onChanged={reload} />}

      {node.children === 0 && (
        <section className="panel mem-fact" aria-label="What AGENCY knows">
          {detailsText(node.attributes, node.label) && (
            <p className="mem-details">{detailsText(node.attributes, node.label)}</p>
          )}
          <p className="mem-why">
            <strong>Why:</strong>{" "}
            {node.reason ??
              (node.fromSetup ? "You told AGENCY about this during setup." : "Nothing recorded yet.")}
          </p>
          <p className="muted">
            Chosen {node.timesChosen} time{node.timesChosen === 1 ? "" : "s"}, last{" "}
            {relativeDay(node.lastChosenAt, new Date())}.
          </p>
        </section>
      )}

      {kids.length > 0 && (
        <>
          <div className="grid grid-3 mem-grid">
            {shown.items.map((k) => (
              <div key={k.id} className="mem-cell">
                <Tile
                  title={k.masked ? "Private" : capitalize(k.label)}
                  sub={k.masked ? undefined : detailsText(k.attributes, k.label) || KIND_LABELS[k.kind]}
                  icon={
                    k.kind === "entity"
                      ? "home"
                      : k.kind === "phrase"
                        ? "message"
                        : k.effectiveSensitive
                          ? "shield"
                          : "list"
                  }
                  badge={k.hidden ? "Hidden" : k.pinned ? "Kept" : undefined}
                  onSelect={() => go(`/node/${k.id}`)}
                />
              </div>
            ))}
          </div>
          <Pages page={shown.page} pages={shown.pages} onPage={setPage} label={node.label} />
        </>
      )}

      {node.children === 0 ? (
        <div className="mem-actions" role="group" aria-label="Change this">
          {actionButtons}
        </div>
      ) : (
        <div className="mem-actions">
          <button className="btn btn-xl" onClick={() => setSheet("actions")} data-dwell>
            <Icon name="edit" /> Change or forget {node.label}
          </button>
        </div>
      )}
      {act.error && <ErrorNote message={act.error} />}

      {sheet === "actions" && (
        <ActionSheet title={`Change ${node.label}`} onClose={() => setSheet(null)}>
          {actionButtons}
        </ActionSheet>
      )}
      {sheet === "forget" && (
        <ConfirmSheet
          title={`Forget ${node.label}?`}
          confirmLabel="Forget it"
          tone="danger"
          busy={act.busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.forget(id);
              setSheet(null);
              back();
            })
          }
        >
          <p>
            AGENCY will forget {node.label}
            {node.children > 0 ? ` and everything under it (${leafCount(tree.data ?? [], id)} things)` : ""},
            including every time you chose it. This can't be undone.
          </p>
        </ConfirmSheet>
      )}
      {sheet === "rename" && (
        <RenameSheet
          name={name}
          onName={setName}
          busy={act.busy}
          onCancel={() => setSheet(null)}
          onSave={() =>
            act.run(async () => {
              await api.patch(id, { label: name.trim() });
              setSheet(null);
              reload();
            })
          }
        />
      )}
    </div>
  );
}

function ActionSheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, []);
  return (
    <div className="sheet-backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="actions-title"
        data-dwell-scope="modal"
      >
        <h2 id="actions-title">{title}</h2>
        <div className="mem-actions mem-actions-sheet">
          {children}
          <button className="btn btn-xl btn-quiet" onClick={onClose} data-dwell>
            <Icon name="back" /> Go back
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameSheet({
  name,
  onName,
  busy,
  onCancel,
  onSave,
}: {
  name: string;
  onName: (v: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, []);
  return (
    <div className="sheet-backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        data-dwell-scope="modal"
      >
        <h2 id="rename-title">Rename</h2>
        <label className="field">
          <span>New name (use the on-screen keyboard)</span>
          <input
            className="mem-input"
            value={name}
            maxLength={120}
            autoFocus
            onChange={(e) => onName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onSave();
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        <div className="sheet-actions">
          <button className="btn btn-xl btn-quiet" onClick={onCancel} data-dwell disabled={busy}>
            <Icon name="back" /> Go back
          </button>
          <button
            className="btn btn-xl btn-primary"
            onClick={onSave}
            data-dwell
            disabled={busy || !name.trim()}
          >
            <Icon name="check" /> Save name
          </button>
        </div>
      </div>
    </div>
  );
}

// -- privacy and control ---------------------------------------------------------------------
type PrivacySheet = "export" | "forget-all" | "forget-all-2" | "encrypt" | null;

function PrivacyView() {
  const api = useMemoryApi();
  const overview = useLoad(() => api.overview(), []);
  const act = useAction();
  const [sheet, setSheet] = useState<PrivacySheet>(null);
  const [page, setPage] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const o = overview.data;
  if (overview.error) return <ErrorNote message={overview.error} onRetry={overview.reload} />;
  if (!o) return <div className="page mem" aria-busy="true" />;
  const save = (patch: Partial<Overview["settings"]>) =>
    act.run(async () => {
      await api.saveSettings({ ...o.settings, ...patch });
      overview.reload();
    });
  const fade = FADE_CHOICES.find((c) => c.days === o.settings.halfLifeDays);
  const tiles: { key: string; node: ReactNode }[] = [
    {
      key: "private",
      node: (
        <Tile
          title="Private mode"
          sub="Keep health, money and relationships off the screen"
          icon="shield"
          pressed={o.settings.privateMode}
          onSelect={() => save({ privateMode: !o.settings.privateMode })}
        />
      ),
    },
    {
      key: "pause",
      node: (
        <Tile
          title="Pause learning"
          sub={
            o.settings.learningPaused
              ? "Nothing new is being remembered"
              : "AGENCY is learning from your choices"
          }
          icon="pause"
          pressed={o.settings.learningPaused}
          onSelect={() => save({ learningPaused: !o.settings.learningPaused })}
        />
      ),
    },
    {
      key: "fade",
      node: (
        <Tile
          title="How fast habits fade"
          sub={fade ? fade.sub : `Half-life ${o.settings.halfLifeDays} days`}
          icon="clock"
          onSelect={() => go("/fade")}
        />
      ),
    },
    {
      key: "notes",
      node: (
        <Tile
          title="Notes by Claude"
          sub={o.settings.summariesEnabled ? "Allowed, only when you send" : "Off. Nothing is sent"}
          icon="sparkle"
          onSelect={() => go("/summary")}
        />
      ),
    },
    {
      key: "caregivers",
      node: (
        <Tile
          title="Caregiver access"
          sub={
            o.grants.length
              ? `${o.grants.map((g) => g.caregiver).join(", ")} can look`
              : "Nobody else can look"
          }
          icon="hand"
          onSelect={() => go("/caregivers")}
        />
      ),
    },
    {
      key: "export",
      node: (
        <Tile
          title="Save a copy"
          sub="Everything AGENCY knows, as a file"
          icon="document"
          onSelect={() => setSheet("export")}
        />
      ),
    },
    {
      key: "encrypt",
      node: (
        <Tile
          title="Lock with the keychain"
          sub={
            o.encryption.enabled
              ? "Encrypted on this Mac"
              : o.encryption.available
                ? "Not encrypted"
                : "Needs macOS"
          }
          icon="key"
          pressed={o.encryption.enabled}
          onSelect={() => setSheet("encrypt")}
        />
      ),
    },
    {
      key: "forget-all",
      node: (
        <Tile
          title="Forget everything"
          sub="Start again from nothing"
          icon="x"
          tone="danger"
          onSelect={() => setSheet("forget-all")}
        />
      ),
    },
  ];
  const shown = pageOf(tiles, page, 6);
  return (
    <div className="page mem" aria-label="Privacy and control">
      <Head eyebrow="Memory" title="Privacy and control" back={() => go()}>
        Everything AGENCY remembers stays on this computer ({o.counts.events} choices about {o.counts.nodes}{" "}
        things).
      </Head>
      {done && (
        <div className="panel panel-accent" role="status">
          {done}
        </div>
      )}
      {act.error && <ErrorNote message={act.error} />}
      <div className="grid grid-3 mem-grid">
        {shown.items.map((t) => (
          <div key={t.key} className="mem-cell">
            {t.node}
          </div>
        ))}
      </div>
      <Pages page={shown.page} pages={shown.pages} onPage={setPage} label="Privacy" />
      {sheet === "export" && (
        <ConfirmSheet
          title="Save a copy of your memory?"
          confirmLabel="Save the file"
          busy={act.busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            act.run(async () => {
              const data = await api.exportAll();
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "agency-memory.json";
              a.click();
              URL.revokeObjectURL(url);
              setSheet(null);
              setDone(
                "Saved agency-memory.json to your Downloads folder. It includes private things, so keep it safe.",
              );
            })
          }
        >
          <p>
            The file has everything AGENCY knows, including private things. It is saved on this computer only.
          </p>
        </ConfirmSheet>
      )}
      {sheet === "encrypt" && (
        <ConfirmSheet
          title={o.encryption.enabled ? "Stop encrypting your memory?" : "Encrypt your memory?"}
          confirmLabel={o.encryption.enabled ? "Stop encrypting" : "Encrypt it"}
          busy={act.busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.setEncryption(!o.encryption.enabled);
              setSheet(null);
              overview.reload();
            })
          }
        >
          <p>
            {o.encryption.enabled
              ? "Your memory will be stored without encryption on this computer."
              : "The key is kept in this Mac's keychain. Without it, nobody can read your memory from the database file."}
          </p>
        </ConfirmSheet>
      )}
      {sheet === "forget-all" && (
        <ConfirmSheet
          title="Forget everything?"
          confirmLabel="Yes, forget everything"
          tone="danger"
          onCancel={() => setSheet(null)}
          onConfirm={() => setSheet("forget-all-2")}
        >
          <p>
            AGENCY will forget all {o.counts.nodes} things it knows about you and every choice you made.
            Caregiver access ends too.
          </p>
        </ConfirmSheet>
      )}
      {sheet === "forget-all-2" && (
        <ConfirmSheet
          title="Are you sure? This can't be undone."
          confirmLabel="Forget it all now"
          cancelLabel="No, keep my memory"
          tone="danger"
          busy={act.busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.forgetAll();
              setSheet(null);
              setDone("AGENCY has forgotten everything. It will start learning again from your next choice.");
              overview.reload();
            })
          }
        >
          <p>After this, AGENCY won't remember any of your usuals.</p>
        </ConfirmSheet>
      )}
    </div>
  );
}

function FadeView() {
  const api = useMemoryApi();
  const settings = useLoad(() => api.settings(), []);
  const act = useAction();
  const s = settings.data;
  return (
    <div className="page mem" aria-label="How fast habits fade">
      <Head eyebrow="Privacy and control" title="How fast habits fade" back={() => go("/privacy")}>
        Recent choices count more than old ones. Choose how quickly old habits stop counting.
      </Head>
      {act.error && <ErrorNote message={act.error} />}
      <div className="grid grid-3 mem-grid">
        {FADE_CHOICES.map((c) => (
          <div key={c.days} className="mem-cell">
            <Tile
              title={c.label}
              sub={c.sub}
              icon="clock"
              pressed={s?.halfLifeDays === c.days}
              onSelect={() =>
                s &&
                act.run(async () => {
                  await api.saveSettings({ ...s, halfLifeDays: c.days });
                  settings.reload();
                })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// -- notes by Claude (opt-in) ----------------------------------------------------------------
function SummaryView() {
  const api = useMemoryApi();
  const preview = useLoad<SummaryPreview>(() => api.summaryPreview(), []);
  const notes = useLoad<Note[]>(() => api.notes(), []);
  const settings = useLoad(() => api.settings(), []);
  const act = useAction();
  const [sheet, setSheet] = useState<"enable" | "send" | null>(null);
  const [page, setPage] = useState(0);
  const p = preview.data;
  const facts = pageOf(p?.facts ?? [], page, 5);
  const reload = () => {
    preview.reload();
    notes.reload();
    settings.reload();
  };
  return (
    <div className="page mem" aria-label="Notes by Claude">
      <Head eyebrow="Privacy and control" title="Notes by Claude (optional)" back={() => go("/privacy")}>
        AGENCY can ask Claude, an AI model made by Anthropic, to turn your habits into a few plain notes.
        Nothing is sent unless you allow it and approve the exact list below.
      </Head>
      {act.error && <ErrorNote message={act.error} />}
      {p && settings.data && (
        <>
          <div className="mem-actions">
            <button
              className={`btn btn-xl${p.enabled ? " btn-primary" : ""}`}
              aria-pressed={p.enabled}
              data-dwell
              onClick={() =>
                p.enabled
                  ? act.run(async () => {
                      await api.saveSettings({ ...settings.data!, summariesEnabled: false });
                      reload();
                    })
                  : setSheet("enable")
              }
            >
              <Icon name="sparkle" /> {p.enabled ? "Notes are allowed" : "Allow notes by Claude"}
            </button>
            <button
              className="btn btn-xl"
              data-dwell
              disabled={!p.enabled || !p.available || p.facts.length === 0 || act.busy}
              onClick={() => setSheet("send")}
            >
              <Icon name="right" />{" "}
              {p.facts.length === 1 ? "Send this fact" : `Send these ${p.facts.length} facts`}
            </button>
          </div>
          <section className="panel" aria-labelledby="h-sent">
            <h2 id="h-sent">Exactly what would be sent to {p.destination}</h2>
            {p.facts.length === 0 ? (
              <p className="muted">Nothing yet: only things you chose at least twice are included.</p>
            ) : (
              <ul className="list mem-facts">
                {facts.items.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <p className="small muted">{p.excluded}</p>
            {!p.available && (
              <p className="small">No cloud model is set up on this computer, so nothing can be sent.</p>
            )}
          </section>
          <Pages page={facts.page} pages={facts.pages} onPage={setPage} label="Facts" />
        </>
      )}
      {notes.data && notes.data.length > 0 && (
        <section className="panel" aria-labelledby="h-notes">
          <h2 id="h-notes">Notes Claude wrote from those facts</h2>
          <ul className="list">
            {notes.data.slice(0, 3).map((n) => (
              <li key={n.id} className="row">
                <span>{n.text}</span>
                <span className="spacer" />
                <button
                  className="btn btn-xl btn-danger"
                  data-dwell
                  onClick={() =>
                    act.run(async () => {
                      await api.deleteNote(n.id);
                      notes.reload();
                    })
                  }
                >
                  <Icon name="x" /> Forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {sheet === "enable" && settings.data && (
        <ConfirmSheet
          title="Allow notes by Claude?"
          confirmLabel="Allow"
          busy={act.busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.saveSettings({ ...settings.data!, summariesEnabled: true });
              setSheet(null);
              reload();
            })
          }
        >
          <p>This only allows it. Nothing is sent until you look at the list and choose Send.</p>
        </ConfirmSheet>
      )}
      {sheet === "send" && p && (
        <ConfirmSheet
          title={`Send ${p.facts.length === 1 ? "this fact" : `${p.facts.length} facts`} to ${p.destination}?`}
          confirmLabel="Send them"
          busy={act.busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.summarize(p.factsHash);
              setSheet(null);
              reload();
            })
          }
        >
          <p>Only the list you just saw is sent. Private and hidden things are never included.</p>
        </ConfirmSheet>
      )}
    </div>
  );
}

// -- caregiver access ------------------------------------------------------------------------
const DURATIONS = [
  { days: 1, label: "For a day" },
  { days: 7, label: "For a week" },
  { days: 30, label: "For a month" },
];

function CaregiversView() {
  const api = useMemoryApi();
  const grants = useLoad<Grant[]>(() => api.grants(), []);
  const overview = useLoad(() => api.overview(), []);
  const contacts = useLoad(
    () => lifelineApi.settings().then((s) => s.contacts.filter((c) => c.enabled).map((c) => c.name)),
    [],
  );
  const act = useAction();
  const [step, setStep] = useState<"list" | "who" | "what" | "how-long">("list");
  const [who, setWho] = useState("");
  const [scope, setScope] = useState<Grant["scope"]>("everyday");
  const [days, setDays] = useState(7);
  const [confirm, setConfirm] = useState(false);
  const [code, setCode] = useState<(Grant & { token: string }) | null>(null);
  const [ending, setEnding] = useState<Grant | null>(null);
  const now = new Date().toISOString();
  const active = (grants.data ?? []).filter((g) => !g.revokedAt && g.expiresAt > now);

  if (step === "who") {
    return (
      <div className="page mem" aria-label="Who can look">
        <Head eyebrow="Caregiver access" title="Who can look?" back={() => setStep("list")} />
        {contacts.error && <ErrorNote message="Couldn't load your people. Add them in Lifeline setup." />}
        <div className="grid grid-3 mem-grid">
          {(contacts.data ?? []).slice(0, 6).map((name) => (
            <div key={name} className="mem-cell">
              <Tile
                title={name}
                icon="hand"
                onSelect={() => {
                  setWho(name);
                  setStep("what");
                }}
              />
            </div>
          ))}
        </div>
        {contacts.data && contacts.data.length === 0 && (
          <div className="panel panel-muted">Add people in Lifeline setup first.</div>
        )}
      </div>
    );
  }
  if (step === "what") {
    return (
      <div className="page mem" aria-label="What they can see">
        <Head eyebrow="Caregiver access" title={`What can ${who} see?`} back={() => setStep("who")} />
        <div className="grid grid-2 mem-grid">
          <Tile
            title="Everyday things"
            sub="Food, calls, phrases. Not private things."
            icon="list"
            onSelect={() => {
              setScope("everyday");
              setStep("how-long");
            }}
          />
          <Tile
            title="Everything"
            sub="Including health, money and relationships"
            icon="shield"
            onSelect={() => {
              setScope("everything");
              setStep("how-long");
            }}
          />
        </div>
      </div>
    );
  }
  if (step === "how-long") {
    return (
      <div className="page mem" aria-label="For how long">
        <Head eyebrow="Caregiver access" title="For how long?" back={() => setStep("what")} />
        <div className="grid grid-3 mem-grid">
          {DURATIONS.map((d) => (
            <div key={d.days} className="mem-cell">
              <Tile
                title={d.label}
                icon="clock"
                onSelect={() => {
                  setDays(d.days);
                  setConfirm(true);
                }}
              />
            </div>
          ))}
        </div>
        {act.error && <ErrorNote message={act.error} />}
        {confirm && (
          <ConfirmSheet
            title={`Let ${who} see ${scope === "everyday" ? "everyday things" : "everything"} ${DURATIONS.find((d) => d.days === days)?.label.toLocaleLowerCase()}?`}
            confirmLabel="Allow"
            busy={act.busy}
            onCancel={() => setConfirm(false)}
            onConfirm={() =>
              act.run(async () => {
                setCode(await api.grant(who, scope, days));
                setConfirm(false);
                setStep("list");
                grants.reload();
              })
            }
          >
            <p>
              {who} will be able to look, not change anything. You can end it at any time, and you'll see when
              they looked.
            </p>
          </ConfirmSheet>
        )}
      </div>
    );
  }
  return (
    <div className="page mem" aria-label="Caregiver access">
      <Head eyebrow="Privacy and control" title="Caregiver access" back={() => go("/privacy")}>
        A caregiver can see what AGENCY knows only if you allow it. You choose what they see and for how long.
      </Head>
      {code && (
        <section className="panel panel-accent" role="status">
          <h2>Give {code.caregiver} this code</h2>
          <p className="mono mem-code">{code.token}</p>
          <p className="small">It works until {dateText(code.expiresAt)}. It is shown only now.</p>
        </section>
      )}
      {act.error && <ErrorNote message={act.error} />}
      <div className="stack mem-stack">
        {active.slice(0, 3).map((g) => (
          <div key={g.id} className="panel row">
            <span>
              <strong>{g.caregiver}</strong> can see{" "}
              {g.scope === "everyday" ? "everyday things" : "everything"} until {dateText(g.expiresAt)}.
            </span>
            <span className="spacer" />
            <button className="btn btn-xl btn-danger" data-dwell onClick={() => setEnding(g)}>
              <Icon name="x" /> End access
            </button>
          </div>
        ))}
        {active.length === 0 && <div className="panel panel-muted">Nobody else can see your memory.</div>}
      </div>
      <div className="mem-actions">
        <button
          className="btn btn-xl btn-primary"
          data-dwell
          onClick={() => {
            setCode(null);
            setStep("who");
          }}
        >
          <Icon name="plus" /> Let someone look
        </button>
      </div>
      {overview.data && overview.data.recentAccess.length > 0 && (
        <section className="panel" aria-labelledby="h-looked">
          <h2 id="h-looked">Who looked</h2>
          <ul className="list">
            {overview.data.recentAccess.slice(0, 3).map((a) => (
              <li key={a.at}>
                {a.caregiver} looked {relativeDay(a.at, new Date())}.
              </li>
            ))}
          </ul>
        </section>
      )}
      {ending && (
        <ConfirmSheet
          title={`End ${ending.caregiver}'s access?`}
          confirmLabel="End access"
          tone="danger"
          busy={act.busy}
          onCancel={() => setEnding(null)}
          onConfirm={() =>
            act.run(async () => {
              await api.revoke(ending.id);
              setEnding(null);
              grants.reload();
            })
          }
        >
          <p>Their code stops working straight away.</p>
        </ConfirmSheet>
      )}
    </div>
  );
}

// -- router ----------------------------------------------------------------------------------
export function MemoryExplorer({ segments, api }: { segments: string[]; api?: MemoryApi }) {
  const [a, b] = segments;
  let view: ReactNode;
  if (a === "node" && b) view = <NodeView key={b} id={b} />;
  else if (a === "usuals") view = <UsualsView />;
  else if (a === "privacy") view = <PrivacyView />;
  else if (a === "fade") view = <FadeView />;
  else if (a === "summary") view = <SummaryView />;
  else if (a === "caregivers") view = <CaregiversView />;
  else view = <OverviewView />;
  return api ? <MemoryApiProvider api={api}>{view}</MemoryApiProvider> : view;
}

export type { NodeDetail, TreeNode };
