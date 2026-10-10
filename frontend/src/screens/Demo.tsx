import { useState } from "react";
import { api, lifelineApi } from "../api/client";
import { AgencyFlow } from "../components/AgencyFlow";
import { ErrorNote } from "../components/common";
import { Icon } from "../components/Icon";
import { ProofStrip } from "../components/ProofStrip";
import { Page } from "../components/Shell";
import { CaseBadge, Loading, formatTime } from "../components/status";
import { useConnection } from "../state/connection";
import { navigate } from "../state/router";
import { usePoll } from "../state/usePoll";
import { createPath } from "./NewTask";

const SCENARIOS = [
  {
    icon: "wrench",
    title: "Get moving again",
    subtitle: "Arrange wheelchair repair, check funding, and tell a caregiver.",
    goal: "equipment_repair",
    selections: { issue: "battery" },
    proof: "Planning → approval → recovery → verified booking",
  },
  {
    icon: "calendar",
    title: "Make room for life",
    subtitle: "Move an appointment without navigating a calendar or writing emails.",
    goal: "reschedule_appointment",
    selections: {},
    proof: "A choice becomes a confirmed calendar change",
  },
  {
    icon: "message",
    title: "Stay connected",
    subtitle: "Send a message and arrange a follow-up with a few choices.",
    goal: "message_followup",
    selections: {},
    proof: "A reviewed message with a delivery record",
  },
] as const;

export function Demo() {
  const { health, online, authProblem } = useConnection();
  const cases = usePoll(() => api.cases(), 2000, "demo-cases");
  const faults = usePoll(() => api.faults(), 2000, "demo-faults");
  const report = usePoll(() => lifelineApi.report(), 4000, "demo-lifeline-report");
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = chosen ?? cases.data?.[0]?.id;
  const detail = usePoll(
    () => (selected ? api.case(selected) : Promise.resolve(null)),
    1500,
    `demo-case-${selected ?? "none"}`,
  );
  const timeline = usePoll(
    () => (selected ? api.timeline(selected) : Promise.resolve(null)),
    2000,
    `demo-timeline-${selected ?? "none"}`,
  );
  const data = detail.data;
  const cloud = health?.reasoning;
  const available = online && !authProblem;
  const checks = timeline.data?.verifications ?? [];
  const verified = data?.steps.filter((s) => s.status === "verified").length ?? 0;
  const approvals = timeline.data?.approvals.filter((a) => a.status === "approved").length ?? 0;
  const recovery = data?.steps.some((s) => !!s.recovery_of && s.status === "verified") ?? false;
  const stages = [
    {
      title: "Intention → plan",
      done: !!data,
      description: data
        ? `${data.steps.length} steps · ${data.reasoning.mode === "cloud" ? "cloud-adapted, validated" : "built-in plan"}`
        : "Choose a scenario to create a real case.",
    },
    {
      title: "Person stays in control",
      done: approvals > 0,
      description: `${approvals} approved decisions · actions wait for permission`,
    },
    {
      title: "Failure → recovery",
      done: recovery,
      description: recovery
        ? "Replacement step verified against service records."
        : "Inject a taken slot before approving a repair booking.",
    },
    {
      title: "Proof of the outcome",
      done: data?.status === "completed",
      description: `${verified} verified steps · ${checks.filter((v) => v.passed).length} passing verification records`,
    },
  ];

  const toggleFault = async () => {
    if (!faults.data || busy) return;
    setBusy(true);
    setError(null);
    try {
      faults.set(await api.setFaults({ ...faults.data, repair_slot_taken: !faults.data.repair_slot_taken }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the demo fault.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page label="Live demo">
      <div className="page-head">
        <div>
          <div className="eyebrow">UCSC · Cloud AI · Live demonstration</div>
          <h1>
            A little input.
            <br />
            <span className="accent-text">A lot of independence.</span>
          </h1>
          <p>
            For someone who cannot use a mouse or keyboard, a task can be a hundred barriers. AGENCY turns a
            few deliberate choices into work that gets done and checked.
          </p>
        </div>
        <span className="badge" data-tone={available ? "ok" : "warn"}>
          <span className="live-dot" data-offline={!available} />{" "}
          {available ? "Coordinator connected" : "Connection needs attention"}
        </span>
      </div>

      <AgencyFlow />
      <ProofStrip />

      <section className="panel cloud-proof" aria-labelledby="cloud-heading">
        <span className="tile-icon">
          <Icon name="sparkle" size={28} />
        </span>
        <div>
          <div className="eyebrow">Cloud intelligence. Human authority.</div>
          <h2 id="cloud-heading">
            {!cloud
              ? "Checking reasoning…"
              : cloud.mode === "deterministic"
                ? "Built-in plans are active"
                : cloud.state === "error"
                  ? "Cloud unavailable · fallback active"
                  : "Cloud reasoning is configured"}
          </h2>
          <p>
            {cloud?.description ?? "Waiting for the coordinator."} {cloud?.model && `Model: ${cloud.model}.`}
          </p>
          <p className="small muted">
            AI interprets intentions and adapts plans. AGENCY validates the plan, asks before consequential
            actions, and reads service records to check the result. Camera frames stay on this device.
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/status")} data-dwell>
          <Icon name="info" /> Inspect setup
        </button>
      </section>

      <section className="stack" aria-labelledby="scenarios-heading">
        <div className="section-heading">
          <h2 id="scenarios-heading">Show a life getting easier</h2>
          <span className="small muted">Real workflows · simulated services</span>
        </div>
        <div className="grid grid-3">
          {SCENARIOS.map((scenario, index) => (
            <button
              className={`tile scenario-tile ${index === 0 ? "tile-primary" : ""}`}
              key={scenario.goal}
              onClick={() => navigate(createPath(scenario.goal, scenario.selections))}
              data-dwell
              disabled={!available}
            >
              <div className="scenario-top">
                <span className="tile-icon">
                  <Icon name={scenario.icon} size={28} />
                </span>
                <span className="small">
                  0{index + 1}
                  {index === 0 ? " · Flagship" : ""}
                </span>
              </div>
              <span className="tile-title">{scenario.title}</span>
              <span className="tile-sub">{scenario.subtitle}</span>
              <span className="scenario-proof">
                {scenario.proof}
                <Icon name="right" size={20} />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel stack" aria-labelledby="demo-proof-heading">
        <div className="section-heading">
          <div>
            <div className="eyebrow">The proof, as it happens</div>
            <h2 id="demo-proof-heading">Follow a real case</h2>
          </div>
          {data && <CaseBadge status={data.status} label={data.status_label} />}
        </div>
        {cases.error && <ErrorNote message={cases.error} onRetry={() => void cases.reload()} />}
        {cases.loading && !cases.data ? (
          <Loading />
        ) : !cases.data?.length ? (
          <div className="demo-empty">
            <Icon name="target" size={38} />
            <h3>Start with an intention.</h3>
            <p>Choose a scenario above. Its plan, your decisions, and the evidence will appear here.</p>
          </div>
        ) : (
          <>
            <div className="row" role="group" aria-label="Choose a case to inspect">
              {cases.data.slice(0, 4).map((c) => (
                <button
                  key={c.id}
                  className={`btn ${selected === c.id ? "btn-primary" : ""}`}
                  onClick={() => setChosen(c.id)}
                  aria-pressed={selected === c.id}
                  data-dwell
                >
                  {c.title}
                </button>
              ))}
            </div>
            {detail.error && <ErrorNote message={detail.error} onRetry={() => void detail.reload()} />}
            {timeline.error && <ErrorNote message={timeline.error} onRetry={() => void timeline.reload()} />}
            {!data ? (
              <Loading text="Opening evidence…" />
            ) : (
              <>
                <h3>{data.title}</h3>
                <ol className="demo-stages">
                  {stages.map((stage, index) => (
                    <li key={stage.title} data-done={stage.done}>
                      <span className="stage-number">
                        {stage.done ? <Icon name="check" size={22} /> : `0${index + 1}`}
                      </span>
                      <div>
                        <strong>{stage.title}</strong>
                        <p>{stage.description}</p>
                      </div>
                      <span className="badge" data-tone={stage.done ? "ok" : "neutral"}>
                        {stage.done ? "Observed" : "Not yet observed"}
                      </span>
                    </li>
                  ))}
                </ol>
                <div className="row">
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      navigate(`/case/${data.id}${data.status === "waiting_approval" ? "/approve" : ""}`)
                    }
                    data-dwell
                  >
                    <Icon name={data.status === "waiting_approval" ? "hand" : "right"} />
                    {data.status === "waiting_approval" ? "Review pending actions" : "Open case"}
                  </button>
                  <button className="btn" onClick={() => navigate(`/case/${data.id}/timeline`)} data-dwell>
                    <Icon name="timeline" /> Inspect evidence
                  </button>
                </div>
                {timeline.data?.events.length ? (
                  <div className="demo-event-feed">
                    <h3 className="small eyebrow">Latest recorded events</h3>
                    <ol>
                      {timeline.data.events
                        .slice(-4)
                        .reverse()
                        .map((event) => (
                          <li key={event.id}>
                            <time dateTime={event.ts}>{formatTime(event.ts)}</time>
                            <span>{event.message}</span>
                          </li>
                        ))}
                    </ol>
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </section>

      <div className="grid grid-2">
        <section className="panel stack" aria-labelledby="recovery-heading">
          <div className="eyebrow">Presenter controls</div>
          <h2 id="recovery-heading">
            <Icon name="refresh" /> Show recovery under pressure
          </h2>
          <p>
            After the repair draft is prepared, make its slot unavailable. Approve the booking: AGENCY checks
            the failure and proposes another time for you to approve.
          </p>
          <button
            className="btn"
            aria-pressed={!!faults.data?.repair_slot_taken}
            onClick={() => void toggleFault()}
            disabled={busy || !available || !health?.demo_controls || !faults.data}
            data-dwell
          >
            <Icon name="alert" />
            {faults.data?.repair_slot_taken ? "Taken-slot failure armed" : "Arm a taken-slot failure"}
          </button>
          {error && <ErrorNote message={error} />}
          <p className="small muted">One simulated failure. It never approves an action for you.</p>
        </section>
        <section className="panel stack" aria-labelledby="demo-lifeline-heading">
          <div className="eyebrow">Connection when it matters</div>
          <h2 id="demo-lifeline-heading">
            <Icon name="lifeline" /> A way to ask for help
          </h2>
          <p>
            Three deliberate long blinks can start an alert. The separate coordinator keeps asking contacts
            until someone responds, even when the laptop disconnects.
          </p>
          <div className="row">
            <button className="btn" onClick={() => navigate("/lifeline")} data-dwell>
              <Icon name="lifeline" /> Open Lifeline
            </button>
            <a className="btn" href="#/phones" target="_blank" rel="noreferrer" data-dwell>
              <Icon name="phone" /> Open simulated phones
            </a>
          </div>
          <p className="small muted">
            {report.error
              ? "Response report unavailable."
              : report.data
                ? `${report.data.tests} test alerts · ${report.data.acknowledged} alerts acknowledged. `
                : "Loading response report. "}
            Lifeline is a demonstration, not a medical alarm or emergency service. Real messaging can be
            enabled separately in setup.
          </p>
        </section>
      </div>
    </Page>
  );
}
