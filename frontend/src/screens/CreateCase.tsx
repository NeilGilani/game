import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { GoalPreview, GoalType } from "../api/types";
import { ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { Loading } from "../components/status";
import { useAnnounce } from "../state/announcer";
import { useConnection } from "../state/connection";
import { navigate, type Route } from "../state/router";

const GOAL_NAMES: Record<GoalType, string> = {
  equipment_repair: "Wheelchair repair",
  reschedule_appointment: "Move an appointment",
  admin_request: "Form or renewal",
  message_followup: "Message and follow-up",
};

const APPROVAL_NAMES: Record<string, string> = {
  "repair.submit_request": "Booking the repair",
  "funding.submit": "Sending the inquiry or application",
  "messaging.send": "Sending any message",
  "calendar.reschedule": "Moving the appointment",
};

export function CreateCase({ route }: { route: Route }) {
  const announce = useAnnounce();
  const { health } = useConnection();
  const initial = useMemo(() => {
    const sel: Record<string, string> = {};
    route.query.forEach((v, k) => {
      if (!["goal", "phrases", "text"].includes(k)) sel[k] = v;
    });
    return sel;
  }, [route.query]);
  const goalType = (route.query.get("goal") as GoalType | null) ?? undefined;
  const phrases = route.query.get("phrases")?.split("|").filter(Boolean) ?? [];
  const text = route.query.get("text") ?? undefined;

  const [selections, setSelections] = useState<Record<string, string>>(initial);
  const [preview, setPreview] = useState<GoalPreview | null>(null);
  // Free text and phrases are interpreted once (possibly by the cloud model); later answers
  // refine the structured goal directly so the model isn't asked again for every tap.
  const [derived, setDerived] = useState<{
    goalType: GoalType;
    interpretation: GoalPreview["interpretation"];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [useCloud, setUseCloud] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const body = derived
      ? { goal_type: derived.goalType, selections }
      : { goal_type: goalType, selections, phrases, free_text: text };
    api
      .interpret(body)
      .then((p) => {
        if (cancelled) return;
        if (!derived && p.goal && (text || phrases.length)) {
          setDerived({ goalType: p.goal.goal_type, interpretation: p.interpretation });
        }
        setPreview(derived ? { ...p, interpretation: derived.interpretation } : p);
        // Keep what the interpreter extracted so later answers build on it.
        if (p.selections && Object.keys(p.selections).some((k) => selections[k] !== p.selections![k])) {
          setSelections((s) => ({ ...p.selections, ...s }));
        }
      })
      .catch(
        (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't understand that."),
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(selections), goalType, text, phrases.join("|"), derived, retry]);

  if (error) return <ErrorNote message={error} onRetry={() => setRetry((r) => r + 1)} />;
  if (!preview) return <Loading text="Working out what you need…" />;

  if (!preview.goal) {
    return (
      <Page label="Not a supported task">
        <div className="panel panel-warn stack">
          <h1>I can't do that one yet</h1>
          <p>{preview.unsupported}</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/new")}
            data-dwell
            style={{ alignSelf: "flex-start" }}
          >
            <Icon name="back" /> Choose a task
          </button>
        </div>
      </Page>
    );
  }

  const goal = preview.goal;
  const question = preview.questions[0];
  const cloudPlanning = health?.reasoning.mode !== "deterministic";

  const start = async () => {
    setStarting(true);
    try {
      const created = await api.createCase(goal, useCloud);
      announce(`Started: ${created.title}`);
      navigate(`/case/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the task.");
      setStarting(false);
    }
  };

  return (
    <Page label="Confirm the task">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            New task · {GOAL_NAMES[goal.goal_type]} ·{" "}
            {preview.interpretation.mode === "cloud"
              ? `understood by ${health?.reasoning.label ?? "the cloud model"}`
              : "matched by built-in rules"}
          </div>
          <h1>{goal.outcome}</h1>
          {preview.interpretation.notes.map((n) => (
            <p key={n} className="small">
              {n}
            </p>
          ))}
        </div>
      </div>

      {question ? (
        <section className="panel panel-accent stack" aria-labelledby="h-q">
          <h2 id="h-q">
            <Icon name="question" /> {question.prompt}
          </h2>
          <div className="option-list">
            {question.options.map((o) => (
              <button
                key={o.value}
                className="btn option"
                data-dwell
                onClick={() => setSelections((s) => ({ ...s, [question.key]: o.value }))}
              >
                {o.label}
                {o.description && <span className="opt-desc">{o.description}</span>}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          {preview.toggles.length > 0 && (
            <section className="stack" aria-labelledby="h-opts">
              <h2 id="h-opts" className="small eyebrow">
                Also do this
              </h2>
              <div className="grid grid-3">
                {preview.toggles.map((t) => (
                  <button
                    key={t.key}
                    className="tile"
                    style={{ minHeight: 120 }}
                    aria-pressed={t.value}
                    data-dwell
                    onClick={() =>
                      setSelections((s) => ({
                        ...s,
                        [t.key]:
                          t.key === "follow_up"
                            ? t.value
                              ? "none"
                              : "tomorrow"
                            : t.value
                              ? "false"
                              : "true",
                      }))
                    }
                  >
                    <span className="tile-title">{t.label}</span>
                    <span className="tile-sub">{t.value ? "Yes" : "No"}</span>
                    <span className="tile-check">
                      <Icon name="check" size={22} />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="grid grid-2">
            <section className="panel">
              <h3>
                <Icon name="hand" /> I'll ask before
              </h3>
              <ul className="list">
                {goal.approvals_required.map((a) => (
                  <li key={a}>
                    <Icon name="check" size={20} />
                    {APPROVAL_NAMES[a] ?? a}
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel">
              <h3>
                <Icon name="shield" /> I won't
              </h3>
              <ul className="list">
                {goal.prohibited.map((p) => (
                  <li key={p}>
                    <Icon name="x" size={20} />
                    {p}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="row" style={{ gap: 32 }}>
            <button className="btn btn-xl" onClick={() => navigate("/new")} data-dwell>
              <Icon name="back" /> Back
            </button>
            <button className="btn btn-xl btn-primary" onClick={start} disabled={starting} data-dwell>
              <Icon name="play" /> {starting ? "Planning…" : "Start this task"}
            </button>
            {cloudPlanning && (
              <label className="row small">
                <input type="checkbox" checked={useCloud} onChange={(e) => setUseCloud(e.target.checked)} />
                Let {health?.reasoning.label ?? "the cloud model"} adapt the plan (it is checked by AGENCY's
                validator)
              </label>
            )}
          </div>
          <p className="small muted">
            Starting only plans and prepares drafts. Nothing is booked, sent or submitted until you approve
            it.
          </p>
        </>
      )}
    </Page>
  );
}
