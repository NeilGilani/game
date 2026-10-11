import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { askQuestion, kernelStatus, type FusionEvent, type KernelStatus } from "../api/synapse";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import "./ask.css";

const EXAMPLES = [
  "How can I make text easier to read on my Mac?",
  "What questions should I ask at my next doctor's appointment?",
  "Explain how a software license works in plain language.",
];

export function Ask() {
  const announce = useAnnounce();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [phase, setPhase] = useState("Ready for your question");
  const [busy, setBusy] = useState(false);
  const [hasAsked, setHasAsked] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [limit, setLimit] = useState(512);
  const [budget, setBudget] = useState<FusionEvent | null>(null);
  const [usage, setUsage] = useState<FusionEvent | null>(null);
  const [completion, setCompletion] = useState<FusionEvent | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const value = await kernelStatus(controller.signal);
        if (mounted.current) setStatus(value);
      } catch {
        if (mounted.current) setStatus({ state: "offline", message: "Couldn't reach Synapse-Mesh." });
      }
      if (mounted.current) timer = setTimeout(() => void check(), 5000);
    };
    void check();
    return () => {
      mounted.current = false;
      controller.abort();
      request.current?.abort();
      clearTimeout(timer);
      window.speechSynthesis?.cancel();
    };
  }, []);

  const ask = async () => {
    if (!question.trim() || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setHasAsked(true);
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setAnswer("");
    setError(null);
    setBudget(null);
    setUsage(null);
    setCompletion(null);
    setPhase("Connecting to Synapse-Mesh…");
    announce("Your question is being answered.");
    try {
      await askQuestion(question, unlimited ? null : limit, controller.signal, (event) => {
        if (!mounted.current) return;
        if (event.event === "intent" || event.event === "token_fusion") setBudget(event);
        if (event.event === "intent") setPhase("Preparing your answer…");
        if (event.event === "loading") setPhase("Preparing the model…");
        if (event.event === "fusion") setPhase("Combining specialists…");
        if (event.event === "token" || event.event === "response") {
          setAnswer(event.text ?? "");
          setUsage(event);
          setPhase(event.event === "token" ? "Answering…" : "Finishing…");
        }
        if (event.event === "complete") setCompletion(event);
      });
      if (mounted.current) {
        setPhase("Answer ready");
        announce("Your answer is ready.");
      }
    } catch (err) {
      if (mounted.current) {
        if (controller.signal.aborted) setPhase("Answer stopped");
        else {
          const message = err instanceof Error ? err.message : "Couldn't answer. Please try again.";
          setError(message);
          setPhase("Answer interrupted");
          announce(message, true);
        }
      }
    } finally {
      request.current = null;
      if (mounted.current) setBusy(false);
    }
  };

  const weights = budget?.weights ?? {};
  const specialists = Object.keys(weights).filter(
    (name) => weights[name]! > 0 || (budget?.ideal_weights?.[name] ?? 0) > 0,
  );

  return (
    <div className="page ask-page stack" aria-label="Ask a question">
      <div className="page-head">
        <div>
          <div className="eyebrow">Synapse-Mesh</div>
          <h1>What would you like to know?</h1>
          <p>Ask about anything. Your question is answered by our fused model.</p>
        </div>
        <button className="btn" data-dwell onClick={() => navigate("/")}>
          <Icon name="home" /> Home
        </button>
      </div>
      <div className="ask-connection" role="status">
        <span className="chip" data-tone={status?.state === "offline" ? "warn" : status ? "ok" : "neutral"}>
          <Icon name="sparkle" />
          {!status ? "Checking Synapse-Mesh…" : `Synapse-Mesh · ${status.state}`}
        </span>
        {status?.device && (
          <span>
            {status.execution_mode} · {status.device.toUpperCase()}
          </span>
        )}
        {status?.network && (
          <span>
            Network: {status.network.state} · {status.network.source}
          </span>
        )}
        {status?.message && <span>{status.message}</span>}
      </div>
      <form
        className="panel stack"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <label className="field">
          <span>Your question</span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Type your question here…"
            maxLength={8000}
            rows={3}
            data-dwell
            disabled={busy}
            required
          />
        </label>
        <div className="ask-controls">
          <label className="ask-limit">
            <input
              type="checkbox"
              data-dwell
              checked={unlimited}
              onChange={(e) => setUnlimited(e.target.checked)}
              disabled={busy}
            />
            No token limit
          </label>
          {!unlimited && (
            <label className="field">
              Answer token limit
              <input
                type="number"
                min={16}
                max={32768}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                disabled={busy}
                required
              />
            </label>
          )}
          {busy ? (
            <button
              key="stop"
              type="button"
              className="btn btn-danger"
              data-dwell
              onClick={(event) => {
                event.preventDefault();
                request.current?.abort();
              }}
            >
              <Icon name="stop" /> Stop answer
            </button>
          ) : (
            <button
              key="ask"
              type="submit"
              className="btn btn-primary"
              data-dwell
              disabled={!question.trim()}
            >
              <Icon name="question" /> Answer my question
            </button>
          )}
        </div>
        <p className="muted small">
          Only this question is sent to the configured Synapse-Mesh server. “No token limit” runs until the
          model finishes or its context is full.
        </p>
      </form>
      {!answer && !busy && (
        <div className="ask-examples" aria-label="Example questions">
          {EXAMPLES.map((example) => (
            <button className="btn" key={example} data-dwell onClick={() => setQuestion(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}
      {hasAsked && (
        <section className="panel stack" aria-labelledby="answer-heading">
          <div className="ask-controls">
            <h2 id="answer-heading">Your answer</h2>
            <span role="status">{phase}</span>
          </div>
          <div className="ask-answer" aria-busy={busy}>
            {answer ? (
              <Markdown remarkPlugins={[remarkGfm]}>{answer}</Markdown>
            ) : busy ? (
              "Waiting for the first words…"
            ) : (
              "No answer was generated."
            )}
          </div>
          {usage && (
            <p className="muted small">
              {usage.tokens} tokens · {usage.tokens_per_second?.toFixed(1)} tokens/s
              {completion?.timing?.comparison_wall_ms !== undefined &&
                ` · ${(completion.timing.comparison_wall_ms / 1000).toFixed(2)} s total`}
              {usage.finish_reason === "length" && " · Token limit reached"}
              {usage.finish_reason === "context_limit" && " · Context limit reached"}
            </p>
          )}
          {!!answer && !busy && "speechSynthesis" in window && (
            <button
              className="btn"
              data-dwell
              onClick={() => {
                window.speechSynthesis.cancel();
                if (speaking) {
                  setSpeaking(false);
                  return;
                }
                const utterance = new SpeechSynthesisUtterance(answer);
                utterance.onend = utterance.onerror = () => {
                  if (mounted.current) setSpeaking(false);
                };
                setSpeaking(true);
                window.speechSynthesis.speak(utterance);
              }}
            >
              <Icon name={speaking ? "stop" : "speak"} /> {speaking ? "Stop reading" : "Read answer aloud"}
            </button>
          )}
          {budget && (
            <details className="ask-details">
              <summary data-dwell>Specialists contributing to this answer</summary>
              <p>
                Network: {budget.network?.state} · Budget: {((budget.network_cap ?? 0) * 100).toFixed(0)}%
              </p>
              <table>
                <caption className="sr-only">
                  Ideal and actual specialist weights from the fusion kernel
                </caption>
                <thead>
                  <tr>
                    <th>Specialist</th>
                    <th>Ideal</th>
                    <th>Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {specialists.map((name) => (
                    <tr key={name}>
                      <th scope="row">{name}</th>
                      <td>{((budget.ideal_weights?.[name] ?? 0) * 100).toFixed(1)}%</td>
                      <td>{(weights[name]! * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {completion?.base_restored && <p>Kernel confirmed: base weights restored.</p>}
            </details>
          )}
        </section>
      )}
    </div>
  );
}
