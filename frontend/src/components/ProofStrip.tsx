import { api } from "../api/client";
import { usePoll } from "../state/usePoll";
import { Icon } from "./Icon";

export function ProofStrip() {
  const insights = usePoll(() => api.insights(), 3000, "workflow-insights");
  const data = insights.data;
  const metrics = [
    { icon: "shield", value: data?.steps_verified, label: "Steps verified" },
    { icon: "check", value: data?.cases_completed, label: "Tasks completed" },
    { icon: "hand", value: data?.approved_decisions, label: "Your approvals" },
    { icon: "refresh", value: data?.recovery_steps_verified, label: "Recovery steps verified" },
  ];
  return (
    <section className="proof-strip" aria-label="Measured results from this coordinator">
      {metrics.map((metric) => (
        <div className="proof-metric" key={metric.label}>
          <Icon name={metric.icon} size={22} />
          <strong>{metric.value ?? "—"}</strong>
          <span>{metric.label}</span>
        </div>
      ))}
      <p className="proof-note">
        <span className="live-dot" data-offline={!!insights.error} />
        {insights.error
          ? "Results unavailable · reconnect to refresh"
          : "Live from service records · demo data"}
      </p>
    </section>
  );
}
