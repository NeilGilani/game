/**
 * Asking for help without alarm. Everyday requests go to one chosen carer, only when that is turned on, and only
 * after the person confirms exactly what is sent and to whom. Lifeline (for emergencies) is always one look away and
 * works the same as ever: nothing here touches it.
 */
import { useEffect, useRef, useState } from "react";
import { ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { SecondConfirm } from "../papers/parts";
import { readAloud } from "../papers/speak";
import { navigate, useRoute } from "../state/router";
import { Badge } from "./MyDay";
import { Bar, Choice, Choices, Head, useNow } from "./parts";
import { dailySource } from "./source";
import { HELP_REQUESTS, readTell, tellPath } from "./tell";
import type { CarerView, RequestView } from "./types";
import { dayKey } from "./day";

export function AskHelp() {
  return (
    <div className="flow day" aria-label="Ask for help" data-testid="day-help">
      <Head
        icon="hand"
        eyebrow="Ask for help"
        badge={<Badge />}
        title="What do you need?"
        help="Not urgent. For an emergency, use Lifeline."
      />
      <Choices count={8} label="What do you need?">
        {HELP_REQUESTS.map((r) => (
          <Choice
            key={r.text}
            icon={r.icon}
            label={r.text}
            onPick={() => navigate(tellPath("help", r.text))}
          />
        ))}
        <Choice
          icon="lifeline"
          label="It's urgent"
          sub="Lifeline"
          tone="lifeline"
          onPick={() => navigate("/lifeline")}
        />
      </Choices>
      <Bar />
    </div>
  );
}

type Phase = { at: "ask" } | { at: "sending" } | { at: "sent"; request: RequestView } | { at: "big" };

function carerWords(c: CarerView): string {
  return c.simulated ? `${c.name}'s practice phone` : `${c.name}, by text message`;
}

export function Tell() {
  const route = useRoute();
  const tell = readTell(route.query);
  const now = useNow();
  const [carer, setCarer] = useState<CarerView | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ at: "ask" });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const day = dayKey(now);

  useEffect(() => {
    let live = true;
    dailySource()
      .state(day)
      .then((s) => live && setCarer(s.carer))
      .catch((err: unknown) => {
        if (!live) return;
        setCarer(null);
        setError(err instanceof Error ? err.message : "AGENCY couldn't check who to tell.");
      });
    return () => {
      live = false;
    };
  }, [day]);

  // After sending: watch for the carer's answer.
  const sentId = phase.at === "sent" ? phase.request.id : null;
  const answered = phase.at === "sent" && !!phase.request.reply;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!sentId || answered) return;
    timer.current = setInterval(() => {
      void dailySource()
        .requests()
        .then((list) => {
          const found = list.find((r) => r.id === sentId);
          if (found) setPhase({ at: "sent", request: found });
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [sentId, answered]);

  if (!tell)
    return (
      <div className="flow day" aria-label="Tell my carer">
        <Head icon="hand" eyebrow="Tell my carer" title="There's nothing to tell" />
        <div />
        <Bar />
      </div>
    );

  const send = async () => {
    setPhase({ at: "sending" });
    try {
      const request = await dailySource().request(tell.kind, tell.text);
      setError(null);
      setPhase({ at: "sent", request });
    } catch (err) {
      setError(err instanceof Error ? err.message : "It couldn't be sent.");
      setPhase({ at: "ask" });
    }
  };

  const sayIt = (
    <button className="btn btn-xl" onClick={() => readAloud(tell.text)} data-dwell>
      <Icon name="speak" /> Say it out loud
    </button>
  );
  const showBig = (
    <button className="btn btn-xl" onClick={() => setPhase({ at: "big" })} data-dwell>
      <Icon name="expand" /> Show it big
    </button>
  );

  if (phase.at === "big")
    return (
      <div className="flow day" aria-label="Shown big">
        <p className="day-big" role="status" data-testid="day-big">
          {tell.text}
        </p>
        <div />
        <Bar back={() => setPhase({ at: "ask" })}>{sayIt}</Bar>
      </div>
    );

  if (phase.at === "sent") {
    const r = phase.request;
    const ok = r.status === "delivered" || r.status === "sent";
    const title = !r.carer
      ? "Nobody was told"
      : !ok
        ? `It didn't reach ${r.carer.name}`
        : r.reply_words
          ? `${r.carer.name}: ${r.reply_words}`
          : `Sent to ${r.carer.name}`;
    return (
      <div className="flow day" aria-label="Tell my carer" data-testid="day-sent">
        <Head icon="hand" eyebrow="Tell my carer" badge={<Badge />} title={title} />
        <div className="day-body stack">
          <p className="task-big">"{r.text}"</p>
          {ok && !r.reply && (
            <p className="day-wait" role="status">
              {r.simulated ? "Sent to a practice phone. " : "The text was sent. "}
              Waiting for {r.carer?.name ?? "them"} to answer. You don't need to do anything.
            </p>
          )}
          {r.duplicate && <p className="muted">You asked for this a moment ago, so it wasn't sent twice.</p>}
          {!ok && r.error && <ErrorNote message={r.error} />}
          {!ok && <div className="day-actions">{sayIt}</div>}
        </div>
        <Bar back="/day">
          <button className="btn btn-xl btn-primary" onClick={() => navigate("/day")} data-dwell>
            <Icon name="check" /> OK
          </button>
        </Bar>
      </div>
    );
  }

  // Asking: telling a carer is off, or confirm exactly what goes to whom.
  if (carer === undefined)
    return (
      <div className="flow day" aria-label="Tell my carer">
        <Head icon="hand" eyebrow="Tell my carer" title="One moment…" />
        <div />
        <Bar />
      </div>
    );

  if (carer === null)
    return (
      <div className="flow day" aria-label="Tell my carer" data-testid="day-tell-off">
        <Head
          icon="hand"
          eyebrow="Tell my carer"
          badge={<Badge />}
          title="Telling a carer by phone is off"
          help="A helper can turn it on in Settings, My day. You can say it out loud or show it big for anyone nearby."
        />
        <div className="day-body stack">
          {error && <ErrorNote message={error} />}
          <p className="task-big">"{tell.text}"</p>
          <div className="day-actions">
            {sayIt}
            {showBig}
          </div>
        </div>
        <Bar />
      </div>
    );

  return (
    <div className="flow day" aria-label="Tell my carer" data-testid="day-tell">
      <Head
        icon="hand"
        eyebrow="Tell my carer"
        badge={<Badge />}
        title={`Tell ${carer.name}?`}
        help={`AGENCY sends this once to ${carerWords(carer)}, marked "not an emergency". Nobody else is told.`}
      />
      <div className="day-body stack">
        {error && <ErrorNote message={error} />}
        <p className="task-big" data-testid="day-tell-text">
          "{tell.text}"
        </p>
        {!confirming ? (
          <div className="day-actions">
            <button
              className="btn btn-xl btn-primary"
              onClick={() => setConfirming(true)}
              disabled={phase.at === "sending"}
              data-dwell
            >
              <Icon name="message" /> Send to {carer.name}
            </button>
            {sayIt}
          </div>
        ) : (
          <SecondConfirm
            question={`Send "${tell.text}" to ${carerWords(carer)}?`}
            yes={phase.at === "sending" ? "Sending…" : `Yes, send it`}
            onYes={() => void send()}
            onNo={() => setConfirming(false)}
            side="right"
          />
        )}
      </div>
      <Bar />
    </div>
  );
}
