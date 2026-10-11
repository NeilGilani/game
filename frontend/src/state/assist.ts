/**
 * The coordinator's AI assists (backend/agency/assist.py): routed by Synapse-Mesh and the Cisco sentinel, answered
 * by Gemini, checked by the coordinator. Every call has a short timeout and returns null on any failure, so the
 * interface simply keeps its on-device behaviour (built-in plans, word and phrase predictions).
 */
import { accessToken, coordinatorUrl } from "../api/client";
import type { RemotePlanner } from "./fakeAgent";

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers({ "Content-Type": "application/json" });
    const token = accessToken();
    if (token) headers.set("X-Agency-Token", token);
    const r = await fetch(`${coordinatorUrl()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What the coordinator reports about an answer's speed (backend/agency/assist.py _speed). */
interface Speed {
  ms: number;
  route_ms?: number | null;
  lane?: string | null;
  mode?: string | null;
  cached?: boolean;
}

/** One line for the plan: how Synapse made this fast (routing time, lane, cache), in plain words. */
export function speedNote(label: string, speed: Speed | undefined): string | undefined {
  if (!speed) return undefined;
  const secs = (speed.ms / 1000).toFixed(1);
  if (speed.cached) return `Synapse cache: same task as before, planned in ${secs} s with no cloud wait.`;
  const routed =
    typeof speed.route_ms === "number" ? ` routed in ${Math.max(1, Math.round(speed.route_ms))} ms,` : "";
  const lane = speed.lane === "fast" ? "fast lane" : (speed.mode ?? "routed");
  return `Synapse ${lane}:${routed} ${label} planned it in ${secs} s.`;
}

/** Gemini plans each Home task through the coordinator (Synapse routes it; the network budget may say built-in). */
export const planWithCoordinator: RemotePlanner = async (r) => {
  const out = await post<{
    steps: { title: string; risk: string; done: string }[];
    label: string;
    speed?: Speed;
  }>(
    "/api/assist/plan",
    { goal: r.goal.slice(0, 200), kind: r.selections?.kind ?? "", selections: r.selections ?? {} },
    30_000,
  );
  if (!out?.steps) return null;
  const steps = out.steps.filter(
    (s): s is { title: string; risk: "read" | "reversible" | "consequential"; done: string } =>
      s.risk === "read" || s.risk === "reversible" || s.risk === "consequential",
  );
  return steps.length >= 2 ? { steps, label: out.label, speed: speedNote(out.label, out.speed) } : null;
};

/** Four replies to what someone just said, in the person's own style. Null: use the on-device suggestions. */
export async function aiReplies(
  heard: string,
  recent: string[],
): Promise<{ replies: string[]; label: string } | null> {
  return post("/api/assist/replies", { heard: heard.slice(0, 400), recent: recent.slice(0, 20) }, 15_000);
}

/** Up to three ways to finish the started sentence. Null: use the on-device predictions. */
export async function aiComplete(
  text: string,
  recent: string[],
): Promise<{ completions: string[]; label: string } | null> {
  return post("/api/assist/complete", { text: text.slice(0, 200), recent: recent.slice(0, 20) }, 10_000);
}
