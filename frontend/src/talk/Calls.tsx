/**
 * Call someone. The person picks who to call (or enters a number on a big keypad), approves
 * the exact number, and then talks: the other person's words appear large and the replies
 * are big choices. Emergency numbers are refused here; Lifeline is one look away instead.
 */

import { useState } from "react";
import { SIMULATED_PARTIES, checkOutgoingNumber } from "../../../os/tasks/src/index";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import { useTalk } from "./services";
import { ApprovalPanel, Notes, PlanSteps, QuestionCards, ResultPanel } from "./TaskParts";
import { ScreenHead, SimNote } from "./ui";
import { useAgentTask } from "./useAgentTask";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫"];

function Keypad({ onCall, onCancel }: { onCall: (number: string) => void; onCancel: () => void }) {
  const [number, setNumber] = useState("");
  const check = number.replace(/\D/g, "").length >= 3 ? checkOutgoingNumber(number) : null;
  return (
    <div className="talk-stack">
      <output className="talk-message talk-number" aria-live="polite" aria-label="Number">
        {number || <span className="talk-placeholder">Enter a number</span>}
      </output>
      {check && !check.ok && (
        <p className="talk-error" role="alert">
          {check.message}
        </p>
      )}
      <div className="talk-keypad">
        {KEYS.map((k) => (
          <button
            key={k}
            className="talk-key"
            aria-label={k === "⌫" ? "Delete" : k}
            onClick={() => setNumber((n) => (k === "⌫" ? n.slice(0, -1) : (n + k).slice(0, 18)))}
            data-dwell
          >
            {k}
          </button>
        ))}
      </div>
      <div className="talk-row">
        <button className="btn talk-btn btn-quiet" onClick={onCancel} data-dwell>
          <Icon name="back" /> Back
        </button>
        <span className="spacer" />
        <button
          className="btn btn-primary talk-btn"
          onClick={() => onCall(number)}
          disabled={!check?.ok}
          data-dwell
        >
          <Icon name="phone" /> Call {check?.ok ? check.display : ""}
        </button>
      </div>
    </div>
  );
}

export function Calls() {
  const { world, requestHelp } = useTalk();
  const task = useAgentTask(world.agent);
  const [keypad, setKeypad] = useState(false);
  const { view } = task;

  const call = (contactName: string, number: string) =>
    task.start({
      goal: `Call ${contactName}`,
      origin: "talk",
      dryRun: true,
      selections: { pack: "call", contactName, number },
    });

  const heard = view.question?.prompt.replace(/^They said: /, "") ?? null;
  const onCall = view.taskId && !view.result;

  return (
    <div className="page talk-page" aria-label="Call someone">
      <ScreenHead
        eyebrow="Call someone"
        title={onCall ? `On a call: ${view.goal.replace(/^Call /, "")}` : "Who do you want to call?"}
      >
        {onCall ? (
          <button className="btn btn-solid-danger talk-btn" onClick={task.stop} data-dwell>
            <Icon name="stop" /> Hang up and stop
          </button>
        ) : (
          <button className="btn talk-btn btn-quiet" onClick={() => navigate("/")} data-dwell>
            <Icon name="home" /> Home
          </button>
        )}
      </ScreenHead>
      <SimNote>
        Calls are simulated in this build: the pharmacy, clinic and Jordan are scripted. The other person
        always hears first that a text-to-speech voice is speaking for you. Nothing is recorded.
      </SimNote>

      {!view.taskId && !keypad && (
        <div className="talk-tiles">
          {SIMULATED_PARTIES.map((p) => (
            <button
              key={p.id}
              className="tile talk-tile"
              onClick={() => call(p.name.replace(/ \(simulated\)$/, ""), p.number)}
              data-dwell
            >
              <span className="tile-icon">
                <Icon name="phone" size={28} />
              </span>
              <span className="tile-title">{p.name}</span>
            </button>
          ))}
          <button className="tile talk-tile" onClick={() => setKeypad(true)} data-dwell>
            <span className="tile-icon">
              <Icon name="list" size={28} />
            </span>
            <span className="tile-title">Enter a number</span>
          </button>
          <button className="tile talk-tile talk-tile-danger" onClick={requestHelp} data-dwell>
            <span className="tile-icon">
              <Icon name="lifeline" size={28} />
            </span>
            <span className="tile-title">Emergency? Use Lifeline</span>
            <span className="tile-sub">
              Calls can't reach emergency numbers. Lifeline alerts your helpers.
            </span>
          </button>
        </div>
      )}

      {!view.taskId && keypad && (
        <Keypad
          onCancel={() => setKeypad(false)}
          onCall={(n) => {
            setKeypad(false);
            call(n, n);
          }}
        />
      )}

      {view.taskId && (
        <>
          {!view.question && !view.result && <PlanSteps steps={view.steps} />}
          <Notes notes={view.notes} />
          {view.question && (
            <>
              {heard && heard !== view.question.prompt && (
                <p className="talk-heard-line talk-heard-last">“{heard.replace(/^“|”$/g, "")}”</p>
              )}
              <QuestionCards
                question={view.question}
                prompt={heard ? "Your reply" : undefined}
                onAnswer={(id, other) => task.answer(id, other)}
              />
            </>
          )}
          {view.approval && (
            <ApprovalPanel
              approval={view.approval}
              approveLabel="Call now"
              onDecide={(d) => task.decide(d)}
            />
          )}
          {view.result && (
            <ResultPanel result={view.result} onAgain={task.reset} againLabel="Call someone else" />
          )}
        </>
      )}
    </div>
  );
}
