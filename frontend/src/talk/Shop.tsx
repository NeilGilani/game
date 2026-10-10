/**
 * Food and shopping: order the usual (or choose), see every item, fee, tip and total, and
 * approve the exact total. Sandbox store in this build: no real restaurant, no real payment.
 */

import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import { useTalk } from "./services";
import { ApprovalPanel, Notes, PlanSteps, QuestionCards, ResultPanel } from "./TaskParts";
import { ScreenHead, SimNote } from "./ui";
import { useAgentTask } from "./useAgentTask";

export function Shop() {
  const { world } = useTalk();
  const task = useAgentTask(world.agent);
  const { view } = task;
  return (
    <div className="page talk-page" aria-label="Food">
      <ScreenHead eyebrow="Food" title={view.taskId ? world.store.storeName : "What would you like?"}>
        {view.taskId && !view.result ? (
          <button className="btn btn-solid-danger talk-btn" onClick={task.stop} data-dwell>
            <Icon name="stop" /> Stop
          </button>
        ) : (
          <button className="btn talk-btn btn-quiet" onClick={() => navigate("/")} data-dwell>
            <Icon name="home" /> Home
          </button>
        )}
      </ScreenHead>
      <SimNote>
        Sandbox store: no real restaurant and no real payment. You approve the exact total before anything is
        ordered.
      </SimNote>
      {!view.taskId && (
        <div className="talk-tiles">
          <button
            className="tile talk-tile tile-primary"
            onClick={() =>
              task.start({
                goal: "Order food from Thai Basil",
                origin: "talk",
                dryRun: true,
                selections: { pack: "ordering" },
              })
            }
            data-dwell
          >
            <span className="tile-title">Order from {world.store.storeName}</span>
            <span className="tile-sub">Your usual is offered first when AGENCY knows it</span>
          </button>
        </div>
      )}
      {view.taskId && (
        <>
          {!view.question && !view.result && !view.approval && <PlanSteps steps={view.steps} />}
          <Notes notes={view.notes} />
          {view.question && (
            <QuestionCards question={view.question} onAnswer={(id, other) => task.answer(id, other)} />
          )}
          {view.approval && (
            <ApprovalPanel
              approval={view.approval}
              approveLabel={`Pay ${view.approval.details.Total ?? ""}`}
              onDecide={(d) => task.decide(d)}
            />
          )}
          {view.result && <ResultPanel result={view.result} onAgain={task.reset} againLabel="Back to food" />}
        </>
      )}
    </div>
  );
}
