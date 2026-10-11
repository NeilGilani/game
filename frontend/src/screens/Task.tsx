/**
 * A task in progress, driven only by the agent's events: the plan as big steps, live progress, choices as cards,
 * approvals with the exact details, and the result marked checked or not. Stop is always on screen.
 *
 * Approving is two deliberate looks: Approve opens a confirmation whose "Yes" sits on the other side of the screen
 * and only becomes selectable after a short pause, so a lingering gaze can't approve by accident.
 */
import { useEffect, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { likely, taskFocus } from "../input/context";
import { useAgent } from "../state/agent";
import { useAnnounce } from "../state/announcer";
import type { ApprovalRequest, ChoiceQuestion, PlanStepView } from "../state/contracts";
import { navigate } from "../state/router";
import { progressText, type TaskView } from "../state/tasks";

/** The agent's note on how the Synapse layer routed this task (os/agent SYNAPSE_STEP). */
const SYNAPSE_STEP = "synapse:route";

/** How long the confirm button waits before it can be selected. Not a time limit: it waits for the person after. */
export const CONFIRM_PAUSE_MS = 1500;

const KIND_VERB: Record<string, string> = {
  send: "Send",
  purchase: "Pay",
  sign: "Sign",
  call: "Call",
  submit: "Submit",
  delete: "Delete",
  "share-personal-data": "Share",
  "account-or-settings": "Change",
  install: "Install",
};

const STEP_ICON: Record<PlanStepView["status"], string> = {
  pending: "clock",
  running: "refresh",
  done: "check",
  failed: "alert",
  skipped: "skip",
  waiting: "hand",
};

const STEP_TEXT: Record<PlanStepView["status"], string> = {
  pending: "Not started",
  running: "Doing this now",
  done: "Done",
  failed: "Didn't work",
  skipped: "Skipped",
  waiting: "Waiting for you",
};

export function TaskScreen({ id }: { id: string }) {
  const agent = useAgent();
  const t = agent.task(id);
  if (!t) {
    return (
      <div className="task" aria-label="Task">
        <div className="panel stack">
          <h1>This task isn&apos;t here any more</h1>
          <p>Tasks are kept while AGENCY is open. Nothing more will happen with it.</p>
          <button className="btn btn-xl btn-primary" onClick={() => navigate("/")} data-dwell>
            <Icon name="home" /> Home
          </button>
        </div>
      </div>
    );
  }
  return <TaskBody t={t} />;
}

function TaskBody({ t }: { t: TaskView }) {
  const agent = useAgent();
  const announce = useAnnounce();
  const finished = t.phase === "done" || t.phase === "failed" || t.phase === "stopped";

  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const said: Partial<Record<TaskView["phase"], string>> = {
      question: t.question?.prompt,
      approval: t.approval ? `Approval needed: ${t.approval.summary}` : undefined,
      done: t.outcome ? `Done. ${t.outcome.text}` : undefined,
      failed: t.failure ? `Not done. ${t.failure.reason}` : undefined,
      stopped: "Stopped. Nothing more will happen.",
    };
    const text = said[t.phase];
    if (text) announce(text, t.phase === "approval");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.phase, t.question?.id, t.approval?.id]);

  return (
    <div className="task" aria-label="Task">
      <div className="task-head">
        <div>
          <div className="eyebrow">
            Task{" "}
            {(t.dryRun || agent.simulated) && (
              <span className="badge" data-tone="sim">
                Simulated
              </span>
            )}
          </div>
          <h1>{t.goal}</h1>
        </div>
        {!finished && (
          <button
            className="btn btn-xl btn-solid-danger task-stop"
            onClick={() => agent.stop(t.id)}
            data-dwell
            data-protect
          >
            <Icon name="stop" /> Stop this task
          </button>
        )}
      </div>

      <div className="task-body">
        <section className="task-plan" aria-labelledby="h-plan">
          <h2 id="h-plan">
            The plan <span className="muted small">· {progressText(t)}</span>
          </h2>
          {t.notes[SYNAPSE_STEP] && (
            <div className="synapse-route">
              <Icon name="sparkle" size={18} />
              <span>{t.notes[SYNAPSE_STEP]!.summary}</span>
            </div>
          )}
          <ol className="plan-steps">
            {t.steps.map((s) => (
              <li key={s.id} className="plan-step" data-status={s.status}>
                <span className="plan-step-icon">
                  <Icon name={STEP_ICON[s.status]} size={26} />
                </span>
                <span>
                  <span className="plan-step-title">{s.title}</span>
                  <span className="plan-step-state">
                    {s.status !== "running" && t.notes[s.id]
                      ? t.notes[s.id]!.summary
                      : `${STEP_TEXT[s.status]}${s.risk === "consequential" ? " · asks you first" : ""}`}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="task-now" aria-live="polite">
          {t.phase === "question" && t.question ? (
            <Question
              q={t.question}
              onPick={(optionId) => agent.answer(t.id, t.question!.id, optionId)}
              // The agent is waiting for one of these answers: they are the likely targets.
              likelyAnswers={taskFocus(t) === "answer"}
            />
          ) : t.phase === "approval" && t.approval?.kind === "sign" ? (
            // Signing always goes through Talk's signing ceremony (read, then a deliberate confirmation).
            <div className="stack" data-testid="sign-handoff">
              <h2>{t.approval.simulated ? "Sign (simulated)" : "Sign"}</h2>
              <p>{t.approval.summary}</p>
              <div className="btn-row">
                <button
                  className="btn"
                  data-dwell
                  onClick={() =>
                    agent.decide(t.id, {
                      approvalId: t.approval!.id,
                      fingerprint: t.approval!.fingerprint,
                      decision: "decline",
                    })
                  }
                >
                  Don't sign
                </button>
                <span className="spacer" />
                <button
                  className="btn btn-primary"
                  data-dwell
                  data-consequential
                  onClick={() => navigate("/talk/papers")}
                >
                  Read and sign
                </button>
              </div>
            </div>
          ) : t.phase === "approval" && t.approval ? (
            <Approval
              key={t.approval.id}
              a={t.approval}
              onDecide={(decision) =>
                agent.decide(t.id, {
                  approvalId: t.approval!.id,
                  fingerprint: t.approval!.fingerprint,
                  decision,
                })
              }
            />
          ) : t.phase === "done" && t.outcome ? (
            <Result t={t} />
          ) : t.phase === "failed" && t.failure ? (
            <div className="stack">
              <h2>
                <Icon name="alert" /> Not done
              </h2>
              <p className="task-big">{t.failure.reason}</p>
              <div className="task-actions">
                {t.failure.recoverable && (
                  <button
                    className="btn btn-xl btn-primary"
                    onClick={() => {
                      agent.dismiss(t.id);
                      const again = agent.start({
                        goal: t.request.goal,
                        origin: t.request.origin,
                        ...(t.request.selections ? { selections: t.request.selections } : {}),
                      });
                      navigate(`/task/${again}`);
                    }}
                    data-dwell
                  >
                    <Icon name="refresh" /> Try again
                  </button>
                )}
                <HomeButton t={t} />
              </div>
            </div>
          ) : t.phase === "stopped" ? (
            <div className="stack">
              <h2>
                <Icon name="stop" /> Stopped
              </h2>
              <p className="task-big">Nothing more will happen with this task.</p>
              <div className="task-actions">
                <HomeButton t={t} />
              </div>
            </div>
          ) : t.phase === "paused" ? (
            <div className="stack">
              <h2>
                <Icon name="pause" /> Paused
              </h2>
              <p className="task-big">AGENCY is waiting. Nothing happens until you say so.</p>
              <div className="task-actions">
                <button
                  className="btn btn-xl btn-primary"
                  onClick={() => agent.resume(t.id)}
                  data-dwell
                  {...likely(taskFocus(t) === "resume" && "strong")}
                >
                  <Icon name="play" /> Carry on
                </button>
                <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
                  <Icon name="home" /> Home
                </button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <h2>
                <Icon name="refresh" /> Working on it
              </h2>
              <p className="task-big">
                {t.steps.find((s) => s.status === "running")?.title ?? "Making a plan…"}
              </p>
              <p className="muted">AGENCY will ask you before anything important.</p>
              <div className="task-actions">
                <button className="btn btn-xl" onClick={() => agent.pause(t.id)} data-dwell>
                  <Icon name="pause" /> Pause
                </button>
                <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
                  <Icon name="home" /> Home
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function HomeButton({ t }: { t: TaskView }) {
  const agent = useAgent();
  return (
    <button
      className="btn btn-xl"
      onClick={() => {
        agent.dismiss(t.id);
        navigate("/");
      }}
      data-dwell
      // With the task finished, going home is the likely next step.
      {...likely(taskFocus(t) === "finish" && "strong")}
    >
      <Icon name="home" /> Home
    </button>
  );
}

function Question({
  q,
  onPick,
  likelyAnswers,
}: {
  q: ChoiceQuestion;
  onPick: (optionId: string) => void;
  likelyAnswers: boolean;
}) {
  return (
    <div className="stack">
      <h2>
        <Icon name="question" /> {q.prompt}
      </h2>
      <div
        className="flow-options task-choices"
        data-count={q.options.length}
        role="group"
        aria-label={q.prompt}
      >
        {q.options.map((o) => (
          <button
            key={o.id}
            className={`choice ${o.suggestedBecause ? "choice-usual" : ""}`}
            onClick={() => onPick(o.id)}
            data-dwell
            {...likely(likelyAnswers && "strong")}
          >
            {o.image && (
              <span className="choice-pic" aria-hidden>
                <img src={o.image} alt="" />
              </span>
            )}
            <span className="choice-label">{o.label}</span>
            {(o.suggestedBecause ?? o.description) && (
              <span className="choice-sub">{o.suggestedBecause ?? o.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="task-actions">
        <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
      </div>
    </div>
  );
}

function Approval({
  a,
  onDecide,
}: {
  a: ApprovalRequest;
  onDecide: (d: "approve" | "decline" | "change") => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const verb = KIND_VERB[a.kind] ?? "Do it";
  return (
    <div className="approval" data-testid="approval">
      <h2>
        <Icon name="hand" /> Your OK is needed
        {a.simulated && (
          <span className="badge" data-tone="sim">
            Simulated: nothing real happens
          </span>
        )}
      </h2>
      <p className="task-big">{a.summary}</p>
      <div className="approval-body">
        <dl className="approval-details">
          {Object.entries(a.details).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {a.preview && (
          <figure className="approval-preview" aria-label="Preview">
            {a.preview.kind === "screenshot" ? (
              <img src={a.preview.data} alt="Preview of what will be sent" />
            ) : (
              <pre>{a.preview.data}</pre>
            )}
          </figure>
        )}
      </div>
      {confirming ? (
        <ConfirmApprove
          verb={verb}
          a={a}
          onYes={() => onDecide("approve")}
          onNo={() => setConfirming(false)}
        />
      ) : (
        <div className="task-actions approval-actions">
          <button
            className="btn btn-xl btn-primary"
            onClick={() => setConfirming(true)}
            data-dwell
            data-approval-gate
          >
            <Icon name="check" /> Approve
          </button>
          <button className="btn btn-xl" onClick={() => onDecide("change")} data-dwell>
            <Icon name="edit" /> Change
          </button>
          <button className="btn btn-xl" onClick={() => onDecide("decline")} data-dwell>
            <Icon name="x" /> Decline
          </button>
        </div>
      )}
    </div>
  );
}

/** The confirm button is on the far side from Approve and waits a moment before it can be selected. */
function ConfirmApprove({
  verb,
  a,
  onYes,
  onNo,
}: {
  verb: string;
  a: ApprovalRequest;
  onYes: () => void;
  onNo: () => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const timer = setTimeout(() => setReady(true), CONFIRM_PAUSE_MS);
    return () => clearTimeout(timer);
  }, []);
  const amount = a.details.Amount ?? a.details.Who ?? a.details.To ?? a.details.Document;
  return (
    <div className="task-actions approval-confirm" role="group" aria-label="Are you sure?">
      <button className="btn btn-xl" onClick={onNo} data-dwell>
        <Icon name="back" /> No, go back
      </button>
      <span className="spacer" />
      <p id="confirm-why" className="sr-only">
        {ready
          ? "Look here to confirm."
          : "Ready in a moment, so a lingering look can't confirm by accident."}
      </p>
      <button
        className="btn btn-xl btn-primary"
        onClick={onYes}
        disabled={!ready}
        data-dwell
        data-approval-gate
        aria-describedby="confirm-why"
      >
        <Icon name="check" />{" "}
        {ready ? `Yes, ${verb.toLowerCase()}${amount ? ` · ${amount}` : ""}` : "One moment…"}
      </button>
    </div>
  );
}

function Result({ t }: { t: TaskView }) {
  const o = t.outcome!;
  return (
    <div className="stack" data-testid="result">
      <h2>
        <Icon name={o.verified ? "check" : "alert"} />{" "}
        {o.verified ? "Done, and checked" : "Done, but not checked"}
      </h2>
      <p className="task-big">{o.text}</p>
      <p className="result-check" data-verified={o.verified}>
        {o.verified
          ? `How AGENCY checked: ${o.evidence ?? "the service confirmed it."}`
          : "AGENCY couldn't confirm this worked. Please check it yourself or ask a helper."}
      </p>
      {t.decided.some((d) => d.decision === "approve") && (
        <p className="small muted">
          You approved:{" "}
          {t.decided
            .filter((d) => d.decision === "approve")
            .map((d) => d.approval.summary)
            .join(" ")}
        </p>
      )}
      <div className="task-actions">
        <HomeButton t={t} />
      </div>
    </div>
  );
}
