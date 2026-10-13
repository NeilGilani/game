/**
 * Ask AGENCY, beside the page: the person picks (or types, with the eye keyboard) what they want done on this page
 * or on the web, and watches AGENCY do it live: its plan, what it is pressing now (highlighted on the page), its
 * questions as big choices, and, before anything consequential, the exact action to approve. The assistant runs
 * under the agent's guard (os/agent): AGENCY Browser only serves it the same page tools as the Chrome bridge.
 */
import { useEffect, useRef, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { likely } from "../input/context";
import { useAgent } from "../state/agent";
import { useAnnounce } from "../state/announcer";
import type { ApprovalRequest } from "../state/contracts";
import { isFinished, type TaskView } from "../state/tasks";
import { readAloud, type Reading } from "./speech";
import { useBrowserSnapshot, type BrowserTab, type SensitiveKind } from "./store";

const SENSITIVE: Record<SensitiveKind, string> = {
  bank: "a bank or payments site",
  health: "a health records site",
  government: "a government site",
  passwords: "a password manager",
  account: "an account security page",
};

const MAIL_HOSTS =
  /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|mail\.localhost)$/;

interface Idea {
  id: string;
  label: string;
  /** The goal to give AGENCY, or a question to ask first (typed words complete it). */
  goal?: string;
  ask?: { prompt: string; goal: (text: string) => string };
  icon: string;
}

function ideasFor(tab: BrowserTab | null): Idea[] {
  const page = !!tab?.url && !tab.error;
  let host = "";
  try {
    host = tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    host = "";
  }
  const out: Idea[] = [];
  if (page) {
    out.push({
      id: "summary",
      label: "Summarise this page",
      goal: "Summarise this page for me in a few short, plain sentences.",
      icon: "document",
    });
    if (MAIL_HOSTS.test(host))
      out.push({
        id: "reply",
        label: "Reply to this email",
        ask: {
          prompt: "What should the reply say?",
          goal: (t) => `Reply to the email that is open, saying: ${t}`,
        },
        icon: "mail",
      });
    out.push({
      id: "find",
      label: "Find something on this page",
      ask: { prompt: "What should AGENCY find?", goal: (t) => `Find this on the page and show me: ${t}` },
      icon: "search",
    });
    out.push({
      id: "form",
      label: "Fill in this form",
      goal: "Help me fill in the form on this page. Ask me for anything you don't know, and never type passwords.",
      icon: "edit",
    });
  }
  out.push({
    id: "web",
    label: "Find something on the web",
    ask: {
      prompt: "What should AGENCY look for?",
      goal: (t) => `Search the web for this and show me the best answer: ${t}`,
    },
    icon: "globe",
  });
  out.push({
    id: "other",
    label: "Something else",
    ask: { prompt: "What would you like AGENCY to do?", goal: (t) => t },
    icon: "sparkle",
  });
  return out;
}

const KIND_VERB: Record<string, string> = {
  send: "send",
  purchase: "pay",
  sign: "sign",
  call: "call",
  submit: "submit",
  delete: "delete",
  "share-personal-data": "share",
  "account-or-settings": "change it",
  install: "install",
};

function Approval({ a, onDecide }: { a: ApprovalRequest; onDecide: (d: "approve" | "decline") => void }) {
  const [confirming, setConfirming] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    setReady(false);
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const t = window.setTimeout(() => setReady(true), 1500);
    return () => window.clearTimeout(t);
  }, [confirming]);
  // The few that matter most, so Approve and No stay in view without scrolling.
  const rank = (k: string) => {
    const i = ["Total", "Amount", "Item 1", "Site", "Where"].indexOf(k);
    return i < 0 ? 99 : i;
  };
  const details = Object.entries(a.details)
    .filter(([k]) => !/^(Why I'm asking|Agent's description|Button)$/.test(k))
    .sort(([x], [y]) => rank(x) - rank(y))
    .slice(0, 3);
  const amount = a.details.Total ?? a.details.Amount;
  return (
    <div className="bw-ask-approval" data-testid="browser-approval">
      <h3>
        <Icon name="hand" size={26} flat /> Your OK is needed
      </h3>
      {a.simulated && (
        <span className="badge" data-tone="sim">
          Practice site: nothing real happens
        </span>
      )}
      <p className="bw-ask-big">{a.summary}</p>
      <dl className="bw-ask-details">
        {details.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {confirming ? (
        <div className="bw-ask-confirm" role="group" aria-label="Are you sure?">
          <button className="btn btn-xl" onClick={() => setConfirming(false)} data-dwell>
            <Icon name="back" /> No, go back
          </button>
          <button
            className="btn btn-xl btn-primary"
            onClick={() => onDecide("approve")}
            disabled={!ready}
            data-dwell
            data-approval-gate
          >
            <Icon name="check" />{" "}
            {ready ? `Yes, ${KIND_VERB[a.kind] ?? "do it"}${amount ? ` · ${amount}` : ""}` : "One moment…"}
          </button>
        </div>
      ) : (
        <div className="bw-ask-actions">
          <button
            className="btn btn-xl btn-primary"
            onClick={() => setConfirming(true)}
            data-dwell
            data-approval-gate
          >
            <Icon name="check" /> Approve
          </button>
          <button className="btn btn-xl" onClick={() => onDecide("decline")} data-dwell>
            <Icon name="x" /> No
          </button>
        </div>
      )}
    </div>
  );
}

function TaskBody({ t, onAgain }: { t: TaskView; onAgain: () => void }) {
  const agent = useAgent();
  const snap = useBrowserSnapshot();
  const reading = useRef<Reading | null>(null);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => () => reading.current?.stop(), []);
  const finished = isFinished(t);
  const running = t.steps.find((s) => s.status === "running");
  // Only the latest steps, so a question or an approval is always in full view (nothing to scroll).
  const keep = t.phase === "approval" ? 0 : t.phase === "question" ? 1 : 5;
  const shown = keep > 0 ? t.steps.slice(-keep) : [];
  const hidden = t.steps.length - shown.length;
  return (
    <div className="bw-ask-task" aria-live="polite">
      <div className="bw-ask-goal">
        <span className="bw-ask-kicker">
          {finished ? "AGENCY did" : "AGENCY is doing"}
          {t.dryRun && (
            <span className="badge" data-tone="sim">
              Practice
            </span>
          )}
        </span>
        <h3>{t.goal}</h3>
      </div>
      {shown.length > 0 && (
        <ol className="bw-ask-steps" aria-label="Steps">
          {hidden > 0 && (
            <li className="bw-ask-steps-more">
              {hidden} earlier {hidden === 1 ? "step" : "steps"}
            </li>
          )}
          {shown.map((s) => (
            <li key={s.id} data-status={s.status}>
              <Icon
                name={
                  s.status === "done"
                    ? "check"
                    : s.status === "failed"
                      ? "alert"
                      : s.status === "running"
                        ? "play"
                        : "clock"
                }
                size={20}
                flat
              />
              <span>{s.title}</span>
            </li>
          ))}
        </ol>
      )}
      {t.phase === "question" && t.question ? (
        <div className="bw-ask-question">
          <h3>
            <Icon name="question" size={24} flat /> {t.question.prompt}
          </h3>
          {t.question.options.map((o) => (
            <button
              key={o.id}
              className="bw-ask-option"
              onClick={() => agent.answer(t.id, t.question!.id, o.id)}
              data-dwell
              {...likely("strong")}
            >
              <span className="bw-ask-option-label">{o.label}</span>
              {(o.suggestedBecause ?? o.description) && (
                <span className="bw-ask-option-sub">{o.suggestedBecause ?? o.description}</span>
              )}
            </button>
          ))}
        </div>
      ) : t.phase === "approval" && t.approval ? (
        <Approval
          key={t.approval.id}
          a={t.approval}
          onDecide={(decision) =>
            agent.decide(t.id, { approvalId: t.approval!.id, fingerprint: t.approval!.fingerprint, decision })
          }
        />
      ) : t.phase === "done" && t.outcome ? (
        <div className="bw-ask-result" data-verified={t.outcome.verified}>
          <h3>
            <Icon name={t.outcome.verified ? "check" : "alert"} size={24} flat />{" "}
            {t.outcome.verified ? "Done" : "Done, but not checked"}
          </h3>
          <p className="bw-ask-big">{t.outcome.text}</p>
          <button
            className="btn btn-xl"
            onClick={() => {
              if (reading.current) {
                reading.current.stop();
                reading.current = null;
                setSpeaking(false);
                return;
              }
              setSpeaking(true);
              const r = readAloud([t.outcome!.text], () => undefined);
              reading.current = r;
              void r.done.then(() => {
                if (reading.current === r) {
                  reading.current = null;
                  setSpeaking(false);
                }
              });
            }}
            data-dwell
          >
            <Icon name={speaking ? "stop" : "volume"} size={24} flat />{" "}
            {speaking ? "Stop reading" : "Read it to me"}
          </button>
        </div>
      ) : t.phase === "failed" && t.failure ? (
        <div className="bw-ask-result" data-failed>
          <h3>
            <Icon name="alert" size={24} flat /> Not done
          </h3>
          <p className="bw-ask-big">{t.failure.reason}</p>
        </div>
      ) : t.phase === "stopped" ? (
        <div className="bw-ask-result">
          <h3>
            <Icon name="stop" size={24} /> Stopped
          </h3>
          <p>Nothing more will happen with this task.</p>
        </div>
      ) : (
        <div className="bw-ask-working">
          <span className="bw-spinner" aria-hidden />
          <p className="bw-ask-big">{snap.agent.acting ?? running?.title ?? "Making a plan…"}</p>
          <p className="muted small">It will ask you before anything important.</p>
        </div>
      )}
      <div className="bw-ask-foot">
        {finished ? (
          <button className="btn btn-xl btn-primary" onClick={onAgain} data-dwell>
            <Icon name="sparkle" size={24} flat /> Ask something else
          </button>
        ) : (
          <button
            className="btn btn-xl btn-solid-danger"
            onClick={() => agent.stop(t.id)}
            data-dwell
            data-protect
          >
            <Icon name="stop" /> Stop
          </button>
        )}
      </div>
    </div>
  );
}

export function AskPanel({
  tab,
  taskId,
  goal,
  onTask,
  onClose,
}: {
  tab: BrowserTab | null;
  taskId: string | null;
  goal: { text: string; n: number } | null;
  onTask: (id: string | null) => void;
  onClose: () => void;
}) {
  const agent = useAgent();
  const announce = useAnnounce();
  const t = taskId ? agent.task(taskId) : undefined;
  const [asking, setAsking] = useState<Idea | null>(null);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const start = (goalText: string) => {
    const g = goalText.trim().slice(0, 300);
    if (!g) return;
    const selections: Record<string, string> = {
      kind: "web",
      browser: "agency",
      browserTab: tab?.url ? "current" : "new",
    };
    if (tab?.url) {
      selections.page = tab.url;
      selections.pageTitle = tab.title.slice(0, 120);
    }
    // The person's own browsing: real, under the guard's settings (practice-only until a helper allows real actions).
    const id = agent.start({ goal: g, origin: "flow", dryRun: false, selections });
    setAsking(null);
    setText("");
    onTask(id);
    announce(`AGENCY is on it: ${g}`);
  };

  const lastGoal = useRef(0);
  useEffect(() => {
    if (goal && goal.n !== lastGoal.current) {
      lastGoal.current = goal.n;
      start(goal.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal?.n]);

  useEffect(() => {
    if (asking) input.current?.focus();
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, [asking]);

  return (
    <aside className="bw-ask" aria-label="Ask AGENCY">
      <div className="bw-ask-head">
        <h2>
          <Icon name="sparkle" size={26} flat /> Ask AGENCY
        </h2>
        <button className="bw-ask-close" onClick={onClose} data-dwell aria-label="Close Ask AGENCY">
          <Icon name="x" size={24} />
        </button>
      </div>
      {tab?.sensitive && (
        <p className="bw-ask-note" role="note">
          <Icon name="shield" size={20} flat /> This is {SENSITIVE[tab.sensitive]}. AGENCY only reads here,
          unless you approve each step.
        </p>
      )}
      {t ? (
        <TaskBody t={t} onAgain={() => onTask(null)} />
      ) : asking?.ask ? (
        <form
          className="bw-ask-type"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) start(asking.ask!.goal(text));
          }}
        >
          <h3>{asking.ask.prompt}</h3>
          <label htmlFor="bw-ask-input" className="sr-only">
            {asking.ask.prompt}
          </label>
          <input
            id="bw-ask-input"
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
          />
          <button className="btn btn-xl btn-primary" type="submit" disabled={!text.trim()} data-dwell>
            <Icon name="sparkle" size={24} flat /> Ask
          </button>
          <button className="btn btn-xl" type="button" onClick={() => setAsking(null)} data-dwell>
            <Icon name="back" /> Back
          </button>
        </form>
      ) : (
        <div className="bw-ask-ideas">
          <p className="bw-ask-lead">AGENCY asks you before anything important.</p>
          {ideasFor(tab).map((idea) => (
            <button
              key={idea.id}
              className="bw-ask-option"
              onClick={() => (idea.goal ? start(idea.goal) : setAsking(idea))}
              data-dwell
            >
              <span className="bw-ask-option-label">
                <Icon name={idea.icon} size={24} flat /> {idea.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
