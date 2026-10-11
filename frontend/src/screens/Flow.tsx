/**
 * Runs an adventure flow (frontend/src/flows): one question per screen, 2 to 6 big picture choices, Back and Home
 * always in the same place at the bottom, paging instead of scrolling. The end of a flow starts a task, opens an
 * app or goes to another screen.
 */
import { useEffect, useMemo, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import {
  back,
  choose,
  optionsOf,
  pageOf,
  promptOf,
  screenOf,
  setPage,
  startFlow,
  submitText,
  USUAL_ID,
  type FlowState,
} from "../flows/engine";
import { FLOWS } from "../flows/library";
import { likely } from "../input/context";
import { PAGE_SIZE, precisionForNewScreen } from "../input/layout";
import type { FlowDef, FlowOption, FlowOutcome } from "../flows/types";
import { useAgent } from "../state/agent";
import { useAnnounce } from "../state/announcer";
import type { Suggestion } from "../state/contracts";
import { memory } from "../state/memory";
import { apps } from "../state/native";
import { navigate } from "../state/router";

/** Memory gets a moment to offer the usual, so it never appears under the gaze after the choices did. */
const USUAL_WAIT_MS = 1200;

function useUsual(flow: FlowDef): { usual: Suggestion | null; ready: boolean } {
  const [state, setState] = useState<{ usual: Suggestion | null; ready: boolean }>({
    usual: null,
    ready: !flow.usualPath,
  });
  useEffect(() => {
    if (!flow.usualPath) return;
    let live = true;
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), USUAL_WAIT_MS));
    Promise.race([
      memory()
        .usual(flow.usualPath)
        .catch(() => null),
      timeout,
    ]).then((usual) => live && setState({ usual: usual?.task ? usual : null, ready: true }));
    return () => {
      live = false;
    };
  }, [flow.usualPath]);
  return state;
}

/** Where each task pack (os/tasks) has its screens. */
const PACK_SCREENS: Record<string, string> = {
  call: "/talk/call",
  documents: "/talk/papers",
  ordering: "/talk/shop",
};

export function FlowScreen({ id }: { id: string }) {
  const flow = FLOWS[id];
  if (!flow) {
    return (
      <div className="panel stack">
        <h1>That isn't something AGENCY can do yet</h1>
        <button className="btn btn-primary" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
      </div>
    );
  }
  return <FlowRunner key={id} flow={flow} />;
}

function FlowRunner({ flow }: { flow: FlowDef }) {
  const agent = useAgent();
  const announce = useAnnounce();
  const [state, setState] = useState<FlowState>(() => startFlow(flow));
  const [launched, setLaunched] = useState<string | null>(null);
  const { usual, ready } = useUsual(flow);
  const screen = screenOf(flow, state);
  const prompt = promptOf(screen, state.selections);
  const options = useMemo(() => optionsOf(flow, state, usual), [flow, state, usual]);
  // Choices per page follow how precise eye control is (input/layout.ts), fixed for the whole screen so
  // nothing moves while the person is looking: 4 when tracking is rough, 6 normally, 8 when it is sharp.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pageSize = useMemo(() => PAGE_SIZE[precisionForNewScreen()], [state.screenId, state.typing]);
  const page = pageOf(options, state.page, pageSize);

  // New choices under the gaze: pause selection briefly so a lingering look doesn't pick one.
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    document.getElementById("flow-prompt")?.focus({ preventScroll: true });
  }, [state.screenId, state.typing, state.page]);

  useEffect(() => {
    if (state.outcome) void finish(state.outcome);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.outcome]);

  const finish = async (outcome: FlowOutcome) => {
    void memory().record({
      path: [flow.id, ...state.path],
      surface: flow.surface,
      outcome: "chosen",
      attributes: outcome.type === "task" ? outcome.selections : {},
    });
    if (outcome.type === "route") {
      navigate(outcome.path);
    } else if (outcome.type === "launch") {
      const result = await apps().launch(outcome.bundleId);
      const text = result.ok
        ? `${outcome.name} is open${apps().simulated ? " (simulated in the browser)" : ""}.`
        : `Couldn't open ${outcome.name}: ${result.error ?? "unknown problem"}.`;
      announce(text);
      setLaunched(text);
    } else if (outcome.pack && PACK_SCREENS[outcome.pack]) {
      // Task packs (os/tasks) run in Talk, which hosts their pack agent, call simulator and document engine.
      navigate(PACK_SCREENS[outcome.pack]!);
    } else {
      const taskId = agent.start({
        goal: outcome.goal,
        origin: outcome.usual ? "memory-suggestion" : "flow",
        selections: outcome.selections,
      });
      navigate(`/task/${taskId}`);
    }
  };

  const pick = (o: FlowOption) => setState((s) => choose(flow, s, o.id, usual));
  const goBack = () => (state.history.length ? setState(back(state)) : navigate("/"));

  if (launched) {
    return (
      <div className="flow" aria-label={flow.title}>
        <div className="flow-head">
          <div className="eyebrow">{flow.title}</div>
          <h1 id="flow-prompt" tabIndex={-1}>
            {launched}
          </h1>
        </div>
        <div className="flow-options" data-count={2}>
          <button className="choice" onClick={() => navigate("/")} data-dwell>
            <span className="choice-pic">
              <Icon name="home" size={44} />
            </span>
            <span className="choice-label">Home</span>
          </button>
          <button className="choice" onClick={() => navigate("/apps?view=running")} data-dwell>
            <span className="choice-pic">
              <Icon name="grid" size={44} />
            </span>
            <span className="choice-label">Open apps</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow" aria-label={flow.title}>
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name={flow.icon} size={18} /> {flow.title}
        </div>
        <h1 id="flow-prompt" tabIndex={-1}>
          {state.typing ? (screen.text?.label ?? prompt) : prompt}
        </h1>
        {screen.help && !state.typing && <p className="muted">{screen.help}</p>}
      </div>

      {state.typing && screen.text ? (
        <TypeStep
          label={screen.text.label}
          placeholder={screen.text.placeholder ?? ""}
          maxLength={screen.text.maxLength ?? 200}
          onDone={(text) => setState((s) => submitText(flow, s, text))}
        />
      ) : !ready ? (
        <div className="flow-options flow-waiting" aria-busy="true">
          <p className="muted">Getting your choices…</p>
        </div>
      ) : (
        <div
          key={`${state.screenId}-${state.page}`}
          className={`flow-options ${screen.layout === "compare" ? "flow-compare" : ""}`}
          data-count={page.items.length}
          role="group"
          aria-labelledby="flow-prompt"
        >
          {page.items.map((o) =>
            screen.layout === "compare" && o.facts ? (
              <button key={o.id} className="choice compare-card" onClick={() => pick(o)} data-dwell>
                <span className="choice-label">{o.label}</span>
                <dl className="compare-facts">
                  {o.facts.map((f) => (
                    <div key={f.label}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
                <span className="choice-sub">Choose {o.label}</span>
              </button>
            ) : (
              <button
                key={o.id}
                className={`choice ${o.id === USUAL_ID ? "choice-usual" : ""}`}
                onClick={() => pick(o)}
                data-dwell
                // The person's usual (memory) is a guess, so only weakly likely.
                {...likely(o.id === USUAL_ID && "weak")}
              >
                <span className="choice-pic" aria-hidden>
                  {o.image ? (
                    <img src={o.image} alt="" />
                  ) : o.glyph ? (
                    <span className="choice-glyph">{o.glyph}</span>
                  ) : (
                    <Icon name={o.icon ?? "right"} size={44} />
                  )}
                </span>
                <span className="choice-label">{o.label}</span>
                {o.sub && <span className="choice-sub">{o.sub}</span>}
              </button>
            ),
          )}
        </div>
      )}

      <div className="flow-bar" role="group" aria-label="Move around">
        <button className="btn btn-xl" onClick={goBack} data-dwell>
          <Icon name="back" /> Back
        </button>
        <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
        <span className="spacer" />
        {page.pages > 1 && !state.typing && (
          <>
            <button
              className="btn btn-xl"
              onClick={() => setState(setPage(state, page.page - 1))}
              disabled={page.page === 0}
              data-dwell
            >
              <Icon name="left" /> Previous
            </button>
            <span className="muted" aria-live="polite">
              {page.page + 1} of {page.pages}
            </span>
            <button
              className="btn btn-xl"
              onClick={() => setState(setPage(state, page.page + 1))}
              disabled={page.page >= page.pages - 1}
              data-dwell
            >
              More <Icon name="right" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Typing: only when no choice fits. The overlay keyboard (Mac app) or a helper's keyboard types here. */
function TypeStep({
  label,
  placeholder,
  maxLength,
  onDone,
}: {
  label: string;
  placeholder: string;
  maxLength: number;
  onDone: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="flow-type"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(text);
      }}
    >
      <label className="field">
        <span className="sr-only">{label}</span>
        <textarea
          value={text}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={3}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="small muted">
        Type with the on-screen keyboard (Keyboard, on the eye-control bar) or a helper&apos;s keyboard.
      </p>
      <button className="btn btn-xl btn-primary" type="submit" disabled={!text.trim()} data-dwell>
        <Icon name="check" /> Done
      </button>
    </form>
  );
}
