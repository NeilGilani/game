/**
 * The Synapse layer, made visible: Ray's Synapse-Mesh routes every AI request (which experts, how much the network
 * allows) and Gemini answers. These pieces show that decision wherever AI was used, so the person, a helper and a
 * judge can see why AGENCY answered the way it did.
 */
import { api } from "../api/client";
import type { Health, NetworkSnapshot, NetworkState, SynapseRoute } from "../api/types";
import { useConnection } from "../state/connection";
import { usePoll } from "../state/usePoll";
import { Icon } from "./Icon";
import "../styles/synapse.css";

const NETWORK_WORD: Record<NetworkState, string> = {
  good: "good",
  slow: "slow",
  critical: "barely working",
  offline: "offline",
  unknown: "not watched",
};

const TONE: Record<NetworkState, string> = {
  good: "ok",
  slow: "warn",
  critical: "danger",
  offline: "danger",
  unknown: "neutral",
};

export function networkTone(state: NetworkState | undefined): string {
  return TONE[state ?? "unknown"];
}

/** "Synapse · Lean-Fusion" for the status bar, or the network alone when Synapse-Mesh isn't running. */
export function synapseChip(health: Health | null): { text: string; tone: string; title: string } | null {
  const net = health?.network;
  const syn = health?.synapse;
  if (!net && !syn) return null;
  const state = net?.state ?? "unknown";
  const mode = syn?.last_route?.mode;
  const sim = net?.simulated ? " (simulated)" : "";
  const title = [net?.description, net?.detail, syn?.connected ? "Routing: Synapse-Mesh" : syn?.router]
    .filter(Boolean)
    .join(" · ");
  if (syn?.connected) {
    return {
      text: mode ? `Synapse · ${mode}${sim}` : `Synapse · network ${NETWORK_WORD[state]}${sim}`,
      tone: TONE[state],
      title,
    };
  }
  if (state === "unknown") return null;
  return { text: `Network ${NETWORK_WORD[state]}${sim}`, tone: TONE[state], title };
}

/** Expert shares as small bars, in Synapse's order of weight. */
export function ExpertBars({ mixture }: { mixture: Record<string, number> }) {
  const entries = Object.entries(mixture).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <span className="synapse-bars" aria-label="Expert mixture">
      {entries.map(([name, share]) => (
        <span key={name} className="synapse-bar" title={`${name} ${Math.round(share * 100)}%`}>
          <span className="synapse-bar-name">{name}</span>
          <span className="synapse-bar-track" aria-hidden="true">
            <span className="synapse-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
          <span className="synapse-bar-pct">{Math.round(share * 100)}%</span>
        </span>
      ))}
    </span>
  );
}

/** One line: who routed it, the mode, and what Gemini was asked to weigh. */
export function RouteLine({ route }: { route: SynapseRoute | null | undefined }) {
  if (!route) return null;
  const who = route.router === "synapse" ? "Synapse-Mesh" : "AGENCY's stand-in router";
  return (
    <div className="synapse-route" data-decision={route.decision}>
      <Icon name="sparkle" size={18} />
      <span>
        <strong>Routed by {who}.</strong> {route.note}
        {route.simulated_network && <span className="muted"> (simulated network)</span>}
      </span>
      <ExpertBars mixture={route.mixture} />
    </div>
  );
}

const DEMO_STATES: { state: Exclude<NetworkState, "unknown">; label: string }[] = [
  { state: "good", label: "Good" },
  { state: "slow", label: "Congested" },
  { state: "critical", label: "Critical" },
  { state: "offline", label: "Offline" },
];

/** Presenter: simulate the network. Moves Synapse-Mesh's mock telemetry too, so both screens agree. */
export function NetworkDemoControls({ onChange }: { onChange?: (snap: NetworkSnapshot) => void }) {
  const set = (state: Exclude<NetworkState, "unknown"> | null) =>
    void api.setNetworkDemo(state).then((snap) => onChange?.(snap));
  return (
    <div className="synapse-demo" role="group" aria-label="Simulate the network">
      {DEMO_STATES.map((d) => (
        <button
          key={d.state}
          className="btn"
          onClick={() => set(d.state)}
          data-dwell
          aria-label={`Simulate network: ${d.label.toLowerCase()}`}
        >
          {d.label}
        </button>
      ))}
      <button
        className="btn btn-quiet"
        onClick={() => set(null)}
        data-dwell
        aria-label="Simulate network: back to live"
      >
        Live
      </button>
    </div>
  );
}

/** Status screen: the network, the router and the last decisions, with their expert mixtures. */
export function SynapsePanel() {
  const demo = !!useConnection().health?.demo_controls;
  const data = usePoll(() => api.synapse(), 3000, "synapse");
  const s = data.data;
  const net = s?.network;
  return (
    <section className="panel stack" aria-labelledby="h-synapse">
      <h2 id="h-synapse">
        <Icon name="sparkle" /> Synapse layer
      </h2>
      <p>
        Every AI request goes through Synapse-Mesh first: its classifier picks the experts and its Cisco
        network sentinel sets the budget. Gemini then answers with those experts, more lightly on a congested
        network, and not at all when it's critical or offline (AGENCY's built-in plans take over at once).
      </p>
      {s && (
        <p>
          <span className="badge" data-tone={s.connected ? "ok" : "neutral"}>
            {s.connected
              ? "Synapse-Mesh connected"
              : s.configured
                ? "Synapse-Mesh not reachable"
                : "Synapse-Mesh not set up"}
          </span>{" "}
          {!s.connected && <span className="muted">AGENCY&apos;s stand-in router is routing instead.</span>}
        </p>
      )}
      {net && (
        <p>
          <span className="badge" data-tone={networkTone(net.state)}>
            Network {NETWORK_WORD[net.state]}
            {net.simulated ? " (simulated)" : ""}
          </span>{" "}
          <span className="muted">
            {net.detail}
            {net.latency_ms != null ? ` · ${Math.round(net.latency_ms)} ms` : ""}
          </span>
        </p>
      )}
      {demo && <NetworkDemoControls onChange={() => void data.reload()} />}
      {s?.recent.length ? (
        <ol className="synapse-recent">
          {s.recent.slice(0, 6).map((r) => (
            <li key={`${r.at}-${r.purpose}`}>
              <RouteLine route={r} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No AI requests yet in this session.</p>
      )}
    </section>
  );
}
