/**
 * Talks to the AGENCY coordinator (on this MacBook or a Raspberry Pi). The coordinator is
 * the source of truth; this client never decides whether an action succeeded.
 */

import type {
  ActivityEvent,
  AlertDetail,
  AlertSummary,
  Approval,
  CaseDetail,
  CaseListItem,
  Catalog,
  EyeAnswer,
  Faults,
  GoalPreview,
  GoalType,
  Goal,
  Health,
  HeartbeatBody,
  HelpSource,
  LifelineReport,
  LifelineSettings,
  LifelineStatus,
  OutboxMessage,
  Preferences,
  ReasoningStatus,
  Situation,
  Runtime,
  Timeline,
} from "./types";

const COORDINATOR_KEY = "agency.coordinator";
const TOKEN_KEY = "agency.token";

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable: setting lasts for this page only */
  }
}

/** Empty string means "same origin" (the Vite proxy or the coordinator serving the UI). */
export function coordinatorUrl(): string {
  return read(COORDINATOR_KEY).replace(/\/+$/, "");
}

export function setCoordinatorUrl(url: string): void {
  write(COORDINATOR_KEY, url.trim());
}

export function accessToken(): string {
  return read(TOKEN_KEY);
}

export function setAccessToken(token: string): void {
  write(TOKEN_KEY, token.trim());
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly offline: boolean,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 12000);
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const token = accessToken();
  if (token) headers.set("X-Agency-Token", token);
  let response: Response;
  try {
    response = await fetch(`${coordinatorUrl()}${path}`, { ...init, headers, signal: controller.signal });
  } catch {
    throw new ApiError("Can't reach the coordinator.", 0, true);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new ApiError("The coordinator isn't responding.", response.status, true);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail)) detail = "Some details weren't valid. Please check and try again.";
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, response.status, false);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown, timeoutMs?: number) =>
  request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  });

const alertPath = (id: string, action: string) => `/api/lifeline/alerts/${encodeURIComponent(id)}/${action}`;

/** Lifeline (emergency signalling). Short timeouts: a slow answer must never delay the local alarm. */
export const lifelineApi = {
  status: () => request<LifelineStatus>("/api/lifeline/status", { timeoutMs: 5000 }),
  settings: () => request<LifelineSettings>("/api/lifeline/settings"),
  saveSettings: (settings: LifelineSettings) =>
    request<LifelineSettings>("/api/lifeline/settings", { method: "PUT", body: JSON.stringify(settings) }),
  help: (source: HelpSource, test = false) =>
    post<{ alert: AlertDetail; created: boolean }>("/api/lifeline/help", { source, test }, 5000),
  cancel: (id: string) => post<AlertDetail>(alertPath(id, "cancel"), undefined, 5000),
  callNow: (id: string) => post<AlertDetail>(alertPath(id, "now"), undefined, 5000),
  resolve: (id: string) => post<AlertDetail>(alertPath(id, "resolve"), undefined, 5000),
  situation: (id: string, situation: Situation) =>
    post<AlertDetail>(alertPath(id, "situation"), { situation }, 5000),
  answer: (questionId: string, answer: EyeAnswer) =>
    post<AlertDetail>(`/api/lifeline/questions/${encodeURIComponent(questionId)}/answer`, { answer }, 5000),
  requestDispatch: (id: string) => post<AlertDetail>(alertPath(id, "dispatch"), {}, 15000),
  cancelDispatch: (id: string) => post<AlertDetail>(alertPath(id, "dispatch/cancel"), undefined, 15000),
  alert: (id: string) => request<AlertDetail>(`/api/lifeline/alerts/${encodeURIComponent(id)}`),
  alerts: () => request<AlertSummary[]>("/api/lifeline/alerts?limit=50"),
  heartbeat: (beat: HeartbeatBody) =>
    post<{ ok: boolean; server_time: string }>("/api/lifeline/heartbeat", beat, 4000),
  setMonitoring: (armed: boolean) => post<LifelineStatus>("/api/lifeline/monitoring", { armed }),
  checkin: (source: string) => post<LifelineStatus>("/api/lifeline/checkin", { source }, 5000),
  outbox: () => request<{ messages: OutboxMessage[] }>("/api/lifeline/outbox"),
  report: () => request<LifelineReport>("/api/lifeline/report"),
  checkinNow: () => post<LifelineStatus>("/api/lifeline/demo/checkin-now"),
};

/** A response link as this browser can open it (the coordinator may be on another host). */
export function respondUrl(link: string): string {
  return `${coordinatorUrl()}${link}`;
}

export const api = {
  health: () => request<Health>("/api/health", { timeoutMs: 4000 }),
  runtime: () => request<Runtime>("/api/runtime"),
  checkCloud: () => post<ReasoningStatus>("/api/runtime/check-cloud"),
  catalog: () => request<Catalog>("/api/goals/catalog"),
  interpret: (body: {
    goal_type?: GoalType;
    selections?: Record<string, string>;
    phrases?: string[];
    free_text?: string;
  }) => post<GoalPreview>("/api/goals/interpret", body),
  createCase: (goal: Goal, useCloudPlan = true) =>
    post<CaseDetail>("/api/cases", { goal, use_cloud_plan: useCloudPlan }),
  cases: (status?: "active") => request<CaseListItem[]>(`/api/cases${status ? `?status=${status}` : ""}`),
  case: (id: string) => request<CaseDetail>(`/api/cases/${encodeURIComponent(id)}`),
  timeline: (id: string) => request<Timeline>(`/api/cases/${encodeURIComponent(id)}/timeline`),
  pauseCase: (id: string) => post<CaseDetail>(`/api/cases/${encodeURIComponent(id)}/pause`),
  resumeCase: (id: string) => post<CaseDetail>(`/api/cases/${encodeURIComponent(id)}/resume`),
  cancelCase: (id: string) => post<CaseDetail>(`/api/cases/${encodeURIComponent(id)}/cancel`),
  answer: (id: string, stepId: string, value: string) =>
    post<CaseDetail>(`/api/cases/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}/answer`, {
      value,
    }),
  skip: (id: string, stepId: string) =>
    post<CaseDetail>(`/api/cases/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}/skip`),
  approvals: () => request<Approval[]>("/api/approvals?status=pending"),
  decide: (approvalId: string, decision: "approve" | "reject", note?: string) =>
    post<{ approval: Approval; case: CaseDetail }>(
      `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        decision,
        note,
      },
    ),
  decideBatch: (ids: string[], decision: "approve" | "reject") =>
    post<{ approvals: Approval[]; cases: CaseDetail[] }>("/api/approvals/batch", {
      approval_ids: ids,
      decision,
    }),
  edit: (approvalId: string, edits: Record<string, string>) =>
    post<{ approval: Approval; case: CaseDetail }>(`/api/approvals/${encodeURIComponent(approvalId)}/edit`, {
      edits,
    }),
  explain: (approvalId: string) =>
    request<{
      paragraphs: string[];
      source: "deterministic" | "cloud";
      label?: string | null;
      on_device?: boolean;
      model: string | null;
      facts?: string[];
    }>(`/api/approvals/${encodeURIComponent(approvalId)}/explain`, { timeoutMs: 60000 }),
  pauseAll: () => post<{ automation_paused: boolean }>("/api/system/pause"),
  resumeAll: () => post<{ automation_paused: boolean }>("/api/system/resume"),
  preferences: () => request<Preferences>("/api/preferences"),
  savePreferences: (prefs: Preferences) =>
    request<Preferences>("/api/preferences", { method: "PUT", body: JSON.stringify(prefs) }),
  faults: () => request<Faults>("/api/demo/faults"),
  setFaults: (faults: Partial<Faults>) =>
    request<Faults>("/api/demo/faults", { method: "PUT", body: JSON.stringify(faults) }),
  resetDemo: () => post<{ today: string; deadline: string }>("/api/demo/reset"),
  activity: () => request<ActivityEvent[]>("/api/activity?limit=8"),
  calendarEvents: () =>
    request<{
      events: { event_id: string; title: string; starts_at: string; location: string; status: string }[];
    }>("/api/demo-services/calendar/events"),
};
