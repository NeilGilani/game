/**
 * The memory tree over HTTP (/api/memory/*). Every surface can use `memoryApi` (or the
 * `FakeMemoryApi` in ./fake for tests) through the same `MemoryApi` interface.
 */
import { ApiError, accessToken, coordinatorUrl } from "../api/client";
import type {
  ChoiceQuestionLike,
  EncryptionStatus,
  Grant,
  MemorySettings,
  Note,
  NodeDetail,
  Overview,
  Prefill,
  RecordResult,
  SelectionEvent,
  Suggestion,
  SummaryPreview,
  Surface,
  TreeNode,
} from "./types";

export interface MemoryApi {
  record(event: SelectionEvent): Promise<RecordResult>;
  suggestions(surface: Surface, limit?: number, prefix?: string): Promise<Suggestion[]>;
  usual(path: string[]): Promise<Suggestion | null>;
  tree(reveal?: boolean): Promise<TreeNode[]>;
  node(id: string, reveal?: boolean): Promise<NodeDetail>;
  patch(
    id: string,
    patch: { label?: string; pinned?: boolean; hidden?: boolean; sensitive?: boolean },
  ): Promise<TreeNode>;
  forget(id: string): Promise<{ forgotten: number }>;
  forgetAll(): Promise<unknown>;
  exportAll(): Promise<unknown>;
  overview(): Promise<Overview>;
  settings(): Promise<MemorySettings>;
  saveSettings(settings: MemorySettings): Promise<MemorySettings>;
  setEncryption(enabled: boolean): Promise<EncryptionStatus>;
  prefill(path: string[], question: ChoiceQuestionLike): Promise<Prefill | null>;
  summaryPreview(): Promise<SummaryPreview>;
  summarize(factsHash: string): Promise<{ notes: Note[] }>;
  notes(): Promise<Note[]>;
  deleteNote(id: string): Promise<unknown>;
  grants(): Promise<Grant[]>;
  grant(caregiver: string, scope: Grant["scope"], days: number): Promise<Grant & { token: string }>;
  revoke(id: string): Promise<Grant>;
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 12000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const token = accessToken();
  if (token) headers.set("X-Agency-Token", token);
  let response: Response;
  try {
    response = await fetch(`${coordinatorUrl()}/api/memory${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Can't reach the coordinator.", 0, true);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, response.status, response.status >= 502 && response.status <= 504);
  }
  return (await response.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
const id = (value: string) => encodeURIComponent(value);

export const memoryApi: MemoryApi = {
  record: (event) => call("/events", json("POST", event), 5000),
  suggestions: (surface, limit = 6, prefix) => {
    const q = new URLSearchParams({ surface, limit: String(limit) });
    if (prefix) q.set("prefix", prefix);
    return call(`/suggestions?${q}`, {}, 5000);
  },
  usual: (path) => {
    const q = new URLSearchParams();
    path.forEach((p) => q.append("p", p));
    return call(`/usual?${q}`, {}, 5000);
  },
  tree: (reveal = false) => call(`/tree${reveal ? "?reveal=true" : ""}`),
  node: (nodeId, reveal = false) => call(`/nodes/${id(nodeId)}${reveal ? "?reveal=true" : ""}`),
  patch: (nodeId, patch) => call(`/nodes/${id(nodeId)}`, json("PATCH", patch)),
  forget: (nodeId) => call(`/nodes/${id(nodeId)}`, { method: "DELETE" }),
  forgetAll: () => call("/forget-all", json("POST", { confirm: true })),
  exportAll: () => call("/export"),
  overview: () => call("/overview"),
  settings: () => call("/settings"),
  saveSettings: (settings) => call("/settings", json("PUT", settings)),
  setEncryption: (enabled) => call("/encryption", json("PUT", { enabled })),
  prefill: (path, question) => call("/prefill", json("POST", { path, question }), 5000),
  summaryPreview: () => call("/summary/preview"),
  summarize: (factsHash) => call("/summary", json("POST", { factsHash }), 60000),
  notes: () => call("/notes"),
  deleteNote: (noteId) => call(`/notes/${id(noteId)}`, { method: "DELETE" }),
  grants: () => call("/grants"),
  grant: (caregiver, scope, days) => call("/grants", json("POST", { caregiver, scope, days, confirm: true })),
  revoke: (grantId) => call(`/grants/${id(grantId)}`, { method: "DELETE" }),
};

/**
 * Log a selection from any surface. Never throws: memory must not get in the way of the task
 * the person is doing, so a failure only means this choice isn't learned.
 */
export async function logSelection(event: SelectionEvent, client: MemoryApi = memoryApi): Promise<boolean> {
  try {
    const result = await client.record(event);
    return result.stored;
  } catch {
    return false;
  }
}
