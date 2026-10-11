import { accessToken, coordinatorUrl } from "./client";

export interface KernelStatus {
  state: "ready" | "cold" | "busy" | "offline";
  message?: string;
  model?: string;
  device?: string;
  execution_mode?: string;
  network?: { state: string; source: string; network_cap: number };
}

export interface FusionEvent {
  event: string;
  text?: string;
  message?: string;
  weights?: Record<string, number>;
  ideal_weights?: Record<string, number>;
  network_cap?: number;
  network?: { state: string; source: string };
  tokens?: number;
  tokens_per_second?: number;
  finish_reason?: string;
  base_restored?: boolean;
  execution?: { location?: string; device?: string };
  timing?: { comparison_wall_ms?: number; restore_ms?: number };
}

/** Reads complete NDJSON records, including split UTF-8 and an unterminated last line. */
export async function readEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: FusionEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const parse = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as FusionEvent;
    if (!event || typeof event.event !== "string") throw new Error("Invalid answer stream.");
    onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) parse(line);
      if (done) {
        parse(pending);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const headers = () => ({ "Content-Type": "application/json", "X-Agency-Token": accessToken() });

export async function kernelStatus(signal: AbortSignal): Promise<KernelStatus> {
  const response = await fetch(`${coordinatorUrl()}/api/synapse/status`, {
    headers: headers(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error("Couldn't check Synapse-Mesh.");
  return (await response.json()) as KernelStatus;
}

export async function askQuestion(
  question: string,
  maxNewTokens: number | null,
  signal: AbortSignal,
  onEvent: (event: FusionEvent) => void,
): Promise<void> {
  const response = await fetch(`${coordinatorUrl()}/api/synapse/questions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ question, max_new_tokens: maxNewTokens }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(typeof body.detail === "string" ? body.detail : "Couldn't start the answer.");
  }
  if (!response.body) throw new Error("The answer stream is missing.");
  let answered = false;
  let complete = false;
  await readEvents(response.body, (event) => {
    if (event.event === "error") throw new Error(event.message ?? "The answer was interrupted.");
    if (event.event === "response") answered = !!event.text?.trim();
    if (event.event === "complete") {
      if (!answered || event.base_restored !== true) throw new Error("The answer didn't finish correctly.");
      complete = true;
    }
    onEvent(event);
  });
  if (!complete) throw new Error("The connection ended before the answer finished.");
}
