import type { SynapseRoute } from "../api/types";
import { RouteLine } from "../components/Synapse";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Approval } from "../api/types";
import { ConfirmSheet, ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { Loading, SimulatedBadge } from "../components/status";
import { useAnnounce } from "../state/announcer";
import { useInput } from "../state/input";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { useCase } from "./CaseWorkspace";

type Sheet =
  | { kind: "approve"; approval: Approval }
  | { kind: "approve-all"; approvals: Approval[] }
  | { kind: "reject"; approval: Approval }
  | null;

function RecoveryNote({ approval }: { approval: Approval }) {
  const rc = approval.details.recovery_context;
  if (!rc?.reason) return null;
  return (
    <div className="panel panel-warn stack" role="note">
      <h3>
        <Icon name="alert" /> Something went wrong, so I'm proposing a fix
      </h3>
      <p>
        <strong>What happened:</strong> {rc.reason}
      </p>
      {rc.what_happened && (
        <p>
          <strong>What I checked:</strong> {rc.what_happened}
        </p>
      )}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const d = approval.details;
  return (
    <article className="panel stack" aria-labelledby={`h-${approval.id}`}>
      <div className="row">
        <span className="badge" data-tone="warn">
          <Icon name="hand" size={16} /> Needs your approval
        </span>
        <SimulatedBadge text={`${d.integration} (simulated)`} />
      </div>
      <h1 id={`h-${approval.id}`} style={{ fontSize: "1.8rem" }}>
        {d.headline}
      </h1>
      <RecoveryNote approval={approval} />
      <dl className="kv">
        {d.details.map((row) => (
          <div key={row.label} style={{ display: "contents" }}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-3">
        <div>
          <div className="eyebrow">If you approve</div>
          <p>{d.effect}</p>
        </div>
        <div>
          <div className="eyebrow">If you say no</div>
          <p>{d.if_rejected}</p>
        </div>
        <div>
          <div className="eyebrow">Can it be undone?</div>
          <p>{d.reversible}</p>
        </div>
      </div>
    </article>
  );
}

export function Approve({ id }: { id: string }) {
  const c = useCase(id);
  const announce = useAnnounce();
  const { prefs } = usePreferences();
  const input = useInput();
  const [index, setIndex] = useState(0);
  const [oneByOne, setOneByOne] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [explanation, setExplanation] = useState<{
    paragraphs: string[];
    source: string;
    label?: string | null;
    on_device?: boolean;
    model: string | null;
    route?: SynapseRoute | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = c.data?.pending_approvals ?? [];
  const current = pending[Math.min(index, Math.max(0, pending.length - 1))];
  // Hands-free modes always confirm. Mouse/keyboard users may turn confirmation off.
  const mustConfirm = prefs.confirm_consequential || input.mode !== "pointer";

  useEffect(() => {
    setExplanation(null);
    setEditing(false);
  }, [current?.id]);

  if (c.error && !c.data) return <ErrorNote message={c.error} onRetry={() => void c.reload()} />;
  if (!c.data) return <Loading text="Loading approvals…" />;

  const finish = async (message: string) => {
    announce(message);
    setSheet(null);
    setIndex(0);
    await c.reload();
  };

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await finish(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      setSheet(null);
      await c.reload();
    } finally {
      setBusy(false);
    }
  };

  const approveOne = (a: Approval) =>
    mustConfirm
      ? setSheet({ kind: "approve", approval: a })
      : void run(() => api.decide(a.id, "approve"), `Approved: ${a.summary}`);

  if (pending.length === 0) {
    return (
      <Page label="Approvals">
        <div className="panel stack">
          <h1>Nothing is waiting for your approval in this case.</h1>
          <p className="muted">{c.data.status_label}.</p>
          <button
            className="btn btn-xl btn-primary"
            style={{ alignSelf: "flex-start" }}
            onClick={() => navigate(`/case/${id}`)}
            data-dwell
          >
            <Icon name="back" /> Back to the case
          </button>
        </div>
      </Page>
    );
  }

  const packet = pending.length > 1 && !oneByOne;

  return (
    <Page label="Review and decide">
      <div className="page-head">
        <div>
          <div className="eyebrow">{c.data.title}</div>
          <h1 style={{ fontSize: "1.5rem" }}>
            {packet
              ? `${pending.length} actions are ready`
              : `Decision ${Math.min(index, pending.length - 1) + 1} of ${pending.length}`}
          </h1>
          <p>
            Nothing below has happened yet. Each one runs only if you approve it, and I check the result
            afterwards.
          </p>
        </div>
        <button className="btn" onClick={() => navigate(`/case/${id}`)} data-dwell>
          <Icon name="back" /> Back to case
        </button>
      </div>

      {error && <ErrorNote message={error} />}

      {packet ? (
        <>
          <div className="stack">
            {pending.map((a) => (
              <div key={a.id} className="panel row">
                <Icon name={a.details.recovery_context?.reason ? "refresh" : "hand"} />
                <div className="stack" style={{ gap: 4 }}>
                  <strong style={{ fontSize: "1.15rem" }}>{a.summary}</strong>
                  <span className="muted small">
                    {a.details.details
                      .slice(0, 3)
                      .map((r) => `${r.label}: ${r.value}`)
                      .join(" · ")}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ gap: 40 }}>
            <button className="btn btn-xl" onClick={() => setOneByOne(true)} data-dwell>
              <Icon name="list" /> Review one by one
            </button>
            <button
              className="btn btn-xl btn-primary"
              data-dwell
              onClick={() =>
                mustConfirm
                  ? setSheet({ kind: "approve-all", approvals: pending })
                  : void run(
                      () =>
                        api.decideBatch(
                          pending.map((a) => a.id),
                          "approve",
                        ),
                      "Approved all.",
                    )
              }
            >
              <Icon name="check" /> Approve all {pending.length}
            </button>
          </div>
        </>
      ) : (
        current && (
          <div className="decide-layout">
            <div className="stack">
              {explanation && (
                <section className="panel stack" aria-live="polite">
                  <h3>
                    <Icon name={explanation.source === "cloud" ? "sparkle" : "info"} />
                    {explanation.source === "cloud"
                      ? explanation.on_device
                        ? `Explained on this computer by ${explanation.model ?? "the on-device model"}`
                        : `Explained by ${explanation.label ?? "the cloud model"} (${explanation.model})`
                      : "In plain terms"}
                  </h3>
                  {explanation.paragraphs.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                  {explanation.source === "cloud" && (
                    <p className="small muted">
                      The details below come from AGENCY's records, not from the model.
                    </p>
                  )}
                  <RouteLine route={explanation.route} />
                </section>
              )}
              {editing && current.details.edit ? (
                <section className="panel panel-accent stack" aria-labelledby="h-edit">
                  <div className="eyebrow">{current.details.headline}</div>
                  <h2 id="h-edit">
                    <Icon name="edit" /> {current.details.edit.label}
                  </h2>
                  <div className="option-list">
                    {current.details.edit.options.map((o) => (
                      <button
                        key={o.value}
                        className="btn option"
                        data-dwell
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => api.edit(current.id, { [current.details.edit!.field]: o.value }),
                            `Changed to ${o.label}. Please review.`,
                          )
                        }
                      >
                        {o.label}
                        {o.description && <span className="opt-desc">{o.description}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              ) : (
                <ApprovalCard approval={current} />
              )}
              {pending.length > 1 && (
                <div className="row">
                  <button
                    className="btn"
                    disabled={index === 0}
                    onClick={() => setIndex(index - 1)}
                    data-dwell
                  >
                    <Icon name="left" /> Previous
                  </button>
                  <button
                    className="btn"
                    disabled={index >= pending.length - 1}
                    onClick={() => setIndex(index + 1)}
                    data-dwell
                  >
                    Next <Icon name="right" />
                  </button>
                </div>
              )}
            </div>
            <div className="decide-actions" role="group" aria-label="Decision">
              <button
                className="btn btn-xl btn-primary"
                onClick={() => approveOne(current)}
                disabled={busy || editing}
                data-dwell
              >
                <Icon name="check" /> Approve
              </button>
              {current.details.edit && (
                <button
                  className="btn btn-xl"
                  onClick={() => setEditing((e) => !e)}
                  disabled={busy}
                  data-dwell
                  aria-pressed={editing}
                >
                  <Icon name={editing ? "back" : "edit"} /> {editing ? "Keep as it was" : "Change"}
                </button>
              )}
              <button
                className="btn btn-xl"
                disabled={busy}
                data-dwell
                onClick={async () => {
                  setExplanation({
                    paragraphs: ["Getting an explanation…"],
                    source: "deterministic",
                    model: null,
                  });
                  try {
                    setExplanation(await api.explain(current.id));
                  } catch {
                    setExplanation(null);
                  }
                }}
              >
                <Icon name="question" /> Explain
              </button>
              <button
                className="btn btn-xl btn-danger"
                onClick={() => setSheet({ kind: "reject", approval: current })}
                disabled={busy}
                data-dwell
              >
                <Icon name="x" /> Say no
              </button>
              <button
                className="btn"
                disabled={busy}
                data-dwell
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.pauseCase(id);
                    announce("Case paused.");
                    navigate(`/case/${id}`);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Icon name="pause" /> Pause this case
              </button>
            </div>
          </div>
        )
      )}

      {sheet?.kind === "approve" && (
        <ConfirmSheet
          title="Do this now?"
          confirmLabel="Yes, do it"
          busy={busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            run(() => api.decide(sheet.approval.id, "approve"), `Approved: ${sheet.approval.summary}`)
          }
        >
          <p style={{ fontSize: "1.25rem" }}>
            <strong>{sheet.approval.summary}</strong>
          </p>
          <p>{sheet.approval.details.effect}</p>
          <SimulatedBadge text={`${sheet.approval.details.integration} (simulated)`} />
        </ConfirmSheet>
      )}
      {sheet?.kind === "approve-all" && (
        <ConfirmSheet
          title={`Do all ${sheet.approvals.length} now?`}
          confirmLabel={`Yes, do all ${sheet.approvals.length}`}
          busy={busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            run(
              () =>
                api.decideBatch(
                  sheet.approvals.map((a) => a.id),
                  "approve",
                ),
              "Approved all. Working on them now.",
            )
          }
        >
          <ul className="list">
            {sheet.approvals.map((a) => (
              <li key={a.id}>
                <Icon name="check" size={20} />
                <strong>{a.summary}</strong>
              </li>
            ))}
          </ul>
          <p className="small muted">
            All of these use demonstration services. I'll verify each result with the service.
          </p>
        </ConfirmSheet>
      )}
      {sheet?.kind === "reject" && (
        <ConfirmSheet
          title="Say no to this?"
          confirmLabel="Yes, don't do it"
          cancelLabel="Go back"
          tone="danger"
          busy={busy}
          onCancel={() => setSheet(null)}
          onConfirm={() =>
            run(() => api.decide(sheet.approval.id, "reject"), `Declined: ${sheet.approval.summary}`)
          }
        >
          <p style={{ fontSize: "1.25rem" }}>
            <strong>{sheet.approval.summary}</strong>
          </p>
          <p>{sheet.approval.details.if_rejected}</p>
        </ConfirmSheet>
      )}
    </Page>
  );
}
