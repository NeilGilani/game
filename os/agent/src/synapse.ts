/**
 * The Synapse layer for the agent: before a task uses the model, the coordinator routes it through Ray's
 * Synapse-Mesh (its Sifter picks the expert mixture; its Cisco sentinel sets the network budget). The agent then
 * gives Gemini the weighted expert lenses, thinks lightly under Lean-Fusion, and doesn't start a model task under
 * Critical-Fusion or Safe-Mode (saved task packs still run). The coordinator stands in when Synapse-Mesh isn't
 * running, and says so; if the coordinator can't be reached, the agent simply runs as before.
 */

export interface SynapseRoute {
  mode: string;
  decision: "gemini" | "gemini-lean" | "built-in";
  /** System-instruction addendum: the weighted expert lenses. */
  brief: string;
  /** One plain sentence for the person. */
  note: string;
  router: "synapse" | "agency";
  mixture: Record<string, number>;
  network: string;
}

export interface SynapseRouter {
  route(text: string): Promise<SynapseRoute | null>;
}

export class HttpSynapseRouter implements SynapseRouter {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async route(text: string): Promise<SynapseRoute | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/synapse/route`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { "x-agency-token": this.token } : {}),
        },
        body: JSON.stringify({ text: text.slice(0, 8000), purpose: "task" }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      return parseRoute(await res.json());
    } catch {
      return null; // routing is an optimisation; never a reason to fail a task
    }
  }
}

export function parseRoute(data: unknown): SynapseRoute | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const decision = d.decision;
  if (decision !== "gemini" && decision !== "gemini-lean" && decision !== "built-in") return null;
  const mixture: Record<string, number> = {};
  if (d.mixture && typeof d.mixture === "object")
    for (const [k, v] of Object.entries(d.mixture as Record<string, unknown>))
      if (typeof v === "number" && Number.isFinite(v)) mixture[k] = v;
  return {
    mode: typeof d.mode === "string" ? d.mode : "",
    decision,
    brief: typeof d.brief === "string" ? d.brief.slice(0, 4000) : "",
    note: typeof d.note === "string" ? d.note.slice(0, 400) : "",
    router: d.router === "synapse" ? "synapse" : "agency",
    mixture,
    network: typeof d.network === "string" ? d.network : "unknown",
  };
}
