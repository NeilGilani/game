import { api } from "../api/client";
import type { ActivityEvent, Approval, CaseListItem } from "../api/types";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { CaseBadge, Loading, formatTime } from "../components/status";
import { coordinatorLabel, useConnection } from "../state/connection";
import { MODE_LABELS, useInput } from "../state/input";
import { navigate } from "../state/router";
import { usePoll } from "../state/usePoll";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const EVENT_ICON: Record<string, string> = {
  verified: "check",
  case_completed: "check",
  recovery_planned: "refresh",
  step_failed: "alert",
  reconciled: "shield",
};

export function Home() {
  const cases = usePoll<CaseListItem[]>(() => api.cases("active"), 3000, "home-cases");
  const approvals = usePoll<Approval[]>(() => api.approvals(), 3000, "home-approvals");
  const activity = usePoll<ActivityEvent[]>(() => api.activity(), 4000, "home-activity");
  const { health, online } = useConnection();
  const input = useInput();

  const active = cases.data ?? [];
  const pending = approvals.data ?? [];
  const resumable =
    active.find((c) => ["interrupted", "paused", "needs_attention"].includes(c.status)) ?? active[0];
  const coord = coordinatorLabel(health, online);

  return (
    <Page label="Home">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </div>
          <h1>{greeting()}, Riley.</h1>
          <p>
            Tell AGENCY what you want done. It plans the steps, asks before anything important, and checks
            every result.
          </p>
        </div>
      </div>

      <div className="grid grid-4">
        <button
          className="tile tile-primary"
          style={{ gridColumn: "span 2" }}
          onClick={() => navigate("/new")}
          data-dwell
        >
          <span className="tile-icon">
            <Icon name="plus" size={30} />
          </span>
          <span>
            <span className="tile-title">Start a task</span>
            <br />
            <span className="tile-sub">Repairs, appointments, paperwork, messages</span>
          </span>
        </button>
        <button
          className="tile"
          onClick={() => navigate(pending.length ? `/case/${pending[0]!.case_id}/approve` : "/approvals")}
          data-dwell
        >
          <span className="tile-icon">
            <Icon name="hand" size={30} />
          </span>
          <span>
            <span className="tile-title">
              {pending.length ? `${pending.length} waiting for you` : "Nothing to approve"}
            </span>
            <br />
            <span className="tile-sub">{pending.length ? "Review and decide" : "You're all caught up"}</span>
          </span>
        </button>
        <button
          className="tile"
          onClick={() => navigate(resumable ? `/case/${resumable.id}` : "/cases")}
          data-dwell
        >
          <span className="tile-icon">
            <Icon name="resume" size={30} />
          </span>
          <span>
            <span className="tile-title">{resumable ? "Open current case" : "Past cases"}</span>
            <br />
            <span className="tile-sub">{resumable ? resumable.title : "See finished work"}</span>
          </span>
        </button>
      </div>

      <div className="grid grid-3">
        <section className="panel" aria-labelledby="h-progress">
          <h2 id="h-progress">
            <Icon name="refresh" /> In progress
          </h2>
          {cases.loading && !cases.data ? (
            <Loading />
          ) : active.length === 0 ? (
            <p className="muted">No tasks in progress.</p>
          ) : (
            <ul className="list">
              {active.slice(0, 3).map((c) => (
                <li key={c.id} className="stack" style={{ gap: 6 }}>
                  <strong>{c.title}</strong>
                  <CaseBadge status={c.status} label={c.status_label} />
                  <div
                    className="progress"
                    aria-label={`${c.progress.done} of ${c.progress.total} steps done`}
                  >
                    <span style={{ width: `${(100 * c.progress.done) / Math.max(1, c.progress.total)}%` }} />
                  </div>
                  <span className="small muted">
                    {c.progress.done} of {c.progress.total} steps done
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="h-waiting">
          <h2 id="h-waiting">
            <Icon name="hand" /> Waiting for your approval
          </h2>
          {pending.length === 0 ? (
            <p className="muted">
              Nothing is waiting. AGENCY always asks before booking, sending or submitting.
            </p>
          ) : (
            <ul className="list">
              {pending.slice(0, 4).map((a) => (
                <li key={a.id}>
                  <Icon name="hand" size={20} />
                  <span>
                    <strong>{a.summary}</strong>
                    <br />
                    <span className="small muted">{a.case_title}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="h-recent">
          <h2 id="h-recent">
            <Icon name="check" /> Recently done and checked
          </h2>
          {(activity.data ?? []).length === 0 ? (
            <p className="muted">Verified results will appear here.</p>
          ) : (
            <ul className="list">
              {(activity.data ?? []).slice(0, 4).map((e) => (
                <li key={e.id}>
                  <Icon name={EVENT_ICON[e.kind] ?? "info"} size={20} />
                  <span>
                    <span>{e.message}</span>
                    <br />
                    <span className="small muted">
                      {e.case_title} · {formatTime(e.ts)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid grid-3">
        <section className="panel panel-muted">
          <h3>
            <Icon name="eye" /> How you're controlling AGENCY
          </h3>
          <p>
            <strong>{MODE_LABELS[input.mode].long}</strong>
          </p>
          {input.usesCamera && input.status !== "running" ? (
            <button className="btn btn-primary" onClick={() => navigate("/camera")} data-dwell>
              <Icon name="camera" /> Set up the camera
            </button>
          ) : input.calibrationNeeded ? (
            <button className="btn btn-primary" onClick={() => navigate("/calibrate")} data-dwell>
              <Icon name="target" /> Calibrate
            </button>
          ) : (
            <button className="btn" onClick={() => navigate("/preferences")} data-dwell>
              <Icon name="gear" /> Change
            </button>
          )}
        </section>
        <section className="panel panel-muted">
          <h3>
            <Icon name={health?.node.is_raspberry_pi ? "chip" : "laptop"} /> Coordinator
          </h3>
          <p>{coord.long}.</p>
          <p className="small muted">Cases, plans and the audit trail are stored there in SQLite.</p>
        </section>
        <section className="panel panel-muted">
          <h3>
            <Icon name={health?.reasoning.mode === "deterministic" ? "shield" : "sparkle"} /> Reasoning
          </h3>
          <p>{health?.reasoning.description ?? "Checking…"}</p>
          <p className="small muted">
            All services in this demo are simulated. Nothing reaches a real company or person.
          </p>
        </section>
      </div>
    </Page>
  );
}
