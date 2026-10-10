import { Icon } from "./Icon";

const STAGES = [
  { icon: "eye", title: "You choose", detail: "Eyes, blink, switch, or touch" },
  { icon: "sparkle", title: "AGENCY plans", detail: "A goal becomes clear steps" },
  { icon: "hand", title: "You decide", detail: "Approve what matters" },
  { icon: "shield", title: "Results verified", detail: "Checked against service records" },
];

export function AgencyFlow() {
  return (
    <ol className="agency-flow" aria-label="How AGENCY works">
      {STAGES.map((stage, index) => (
        <li key={stage.title}>
          <span className="flow-symbol">
            <Icon name={stage.icon} size={26} />
          </span>
          <span className="flow-copy">
            <strong>{stage.title}</strong>
            <span>{stage.detail}</span>
          </span>
          {index < STAGES.length - 1 && (
            <span className="flow-connector" aria-hidden="true">
              <Icon name="right" size={18} />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
