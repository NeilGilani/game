import { useState } from "react";
import { api } from "../api/client";
import type { Catalog } from "../api/types";
import { ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { Loading } from "../components/status";
import { navigate } from "../state/router";
import { usePoll } from "../state/usePoll";

export function createPath(goalType: string, selections: Record<string, string> = {}): string {
  const q = new URLSearchParams({ goal: goalType, ...selections });
  return `/new/create?${q.toString()}`;
}

export function NewTask() {
  const catalog = usePoll<Catalog>(() => api.catalog(), 15000, "catalog");
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");

  if (catalog.error && !catalog.data)
    return <ErrorNote message={catalog.error} onRetry={() => void catalog.reload()} />;
  if (!catalog.data) return <Loading text="Loading tasks…" />;
  const { cards, suggestions } = catalog.data;

  return (
    <Page label="Start a task">
      <div className="page-head">
        <div>
          <div className="eyebrow">New task</div>
          <h1>What do you want to get done?</h1>
          <p>Choose a task. I'll ask only for what I need, then plan the steps.</p>
        </div>
      </div>

      {suggestions.length > 0 && (
        <section aria-labelledby="h-suggest" className="stack">
          <h2 id="h-suggest" className="small eyebrow">
            Suggested for you
          </h2>
          <div className="row">
            {suggestions.slice(0, 2).map((s) => (
              <button
                key={s.title}
                className="btn btn-primary"
                data-dwell
                onClick={() =>
                  navigate(
                    s.kind === "approvals" && s.case_id
                      ? `/case/${s.case_id}/approve`
                      : s.kind === "resume" && s.case_id
                        ? `/case/${s.case_id}`
                        : createPath(s.goal_type ?? "equipment_repair", s.selections ?? {}),
                  )
                }
              >
                <Icon name="sparkle" /> {s.title}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-3">
        {cards.map((card) => (
          <button
            key={card.goal_type}
            className={`tile ${card.goal_type === "equipment_repair" ? "tile-primary" : ""}`}
            data-dwell
            onClick={() => navigate(card.goal_type === "resume" ? "/cases" : createPath(card.goal_type))}
          >
            <span className="tile-icon">
              <Icon name={card.icon} size={30} />
            </span>
            <span>
              <span className="tile-title">{card.title}</span>
              <br />
              <span className="tile-sub">{card.subtitle}</span>
            </span>
          </button>
        ))}
        <button className="tile" data-dwell onClick={() => navigate("/new/phrases")}>
          <span className="tile-icon">
            <Icon name="message" size={30} />
          </span>
          <span>
            <span className="tile-title">Say it with phrases</span>
            <br />
            <span className="tile-sub">Pick a few phrases and I'll work out the task</span>
          </span>
        </button>
      </div>

      <div className="stack">
        {!typing ? (
          <button
            className="btn btn-quiet"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setTyping(true)}
          >
            <Icon name="edit" /> Type a request instead (keyboard)
          </button>
        ) : (
          <form
            className="panel stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim())
                navigate(`/new/create?${new URLSearchParams({ text: text.trim() }).toString()}`);
            }}
          >
            <label className="field">
              <strong>Describe what you need</strong>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={600}
                autoFocus
                placeholder="I need to arrange a repair for my wheelchair before Friday…"
              />
            </label>
            <div className="row">
              <button className="btn btn-primary" type="submit" disabled={!text.trim()}>
                Continue
              </button>
              <button className="btn" type="button" onClick={() => setTyping(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Page>
  );
}

export function Phrases() {
  const catalog = usePoll<Catalog>(() => api.catalog(), 60000, "catalog-phrases");
  const [chosen, setChosen] = useState<string[]>([]);
  if (!catalog.data) return <Loading />;
  const toggle = (text: string) =>
    setChosen((c) => (c.includes(text) ? c.filter((x) => x !== text) : c.length >= 6 ? c : [...c, text]));
  return (
    <Page label="Build a request from phrases">
      <div className="page-head">
        <div>
          <div className="eyebrow">New task · phrases</div>
          <h1>Pick the phrases that fit</h1>
          <p aria-live="polite">
            {chosen.length
              ? `“${chosen.join(" · ")}”`
              : "Choose up to six. Selected phrases are highlighted."}
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setChosen([])} disabled={!chosen.length} data-dwell>
            <Icon name="x" /> Clear
          </button>
          <button
            className="btn btn-primary"
            disabled={!chosen.length}
            data-dwell
            onClick={() =>
              navigate(`/new/create?${new URLSearchParams({ phrases: chosen.join("|") }).toString()}`)
            }
          >
            Continue <Icon name="right" />
          </button>
        </div>
      </div>
      <div className="grid grid-4">
        {catalog.data.phrases.map((p) => (
          <button
            key={p.id}
            className="tile"
            style={{ minHeight: 120 }}
            aria-pressed={chosen.includes(p.text)}
            onClick={() => toggle(p.text)}
            data-dwell
          >
            <span className="tile-title">{p.text}</span>
            <span className="tile-check">
              <Icon name="check" size={22} />
            </span>
          </button>
        ))}
      </div>
    </Page>
  );
}
