/** Types mirroring the coordinator's JSON responses (backend/agency/main.py). */

export type GoalType = "equipment_repair" | "reschedule_appointment" | "admin_request" | "message_followup";

export type CaseStatus =
  | "planning"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "needs_attention"
  | "paused"
  | "interrupted"
  | "completed"
  | "completed_partial"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "waiting_input"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "retrying"
  | "succeeded"
  | "verified"
  | "failed"
  | "rejected"
  | "skipped"
  | "superseded"
  | "blocked"
  | "cancelled";

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface Question {
  key: string;
  prompt: string;
  options: QuestionOption[];
}

export interface Goal {
  goal_type: GoalType;
  outcome: string;
  deadline: string | null;
  preferences: Record<string, string>;
  entities: Record<string, string>;
  constraints: string[];
  missing_info: string[];
  approvals_required: string[];
  prohibited: string[];
  options: Record<string, boolean>;
}

export interface Toggle {
  key: string;
  label: string;
  value: boolean;
}

export interface GoalPreview {
  goal: Goal | null;
  questions: Question[];
  toggles: Toggle[];
  ready: boolean;
  selections?: Record<string, string>;
  unsupported?: string;
  interpretation: { mode: "deterministic" | "cloud"; notes: string[] };
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  expected: unknown;
  observed: unknown;
}

export interface Step {
  id: string;
  position: number;
  kind: "action" | "ask";
  title: string;
  description: string;
  tool: string;
  inputs: Record<string, unknown> | null;
  depends_on: string[];
  approval: "none" | "required";
  optional: boolean;
  status: StepStatus;
  status_label: string;
  expected_output: string;
  attempts: number;
  question: Question | null;
  output: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  evidence: {
    integration?: string;
    simulated?: boolean;
    reference?: string;
    record?: string;
    record_status?: string;
    verification?: string;
    checks?: VerificationCheck[];
    replayed?: boolean;
  } | null;
  recovery_of: string | null;
  recovery_context: {
    reason?: string;
    what_happened?: string;
    failed_title?: string;
    verified_nothing_happened?: boolean;
    part_of_recovery_for?: string;
  } | null;
  consequential: boolean;
  read_only: boolean;
  integration: string;
  replaced_by: string | null;
}

export interface ApprovalDetails {
  headline: string;
  details: { label: string; value: string }[];
  effect: string;
  if_rejected: string;
  reversible: string;
  edit: { field: string; label: string; options: QuestionOption[] } | null;
  tool: string;
  integration: string;
  simulated: boolean;
  step_title: string;
  recovery_context: Step["recovery_context"];
}

export interface Approval {
  id: string;
  case_id: string;
  step_id: string;
  status: "pending" | "approved" | "rejected" | "superseded" | "withdrawn";
  summary: string;
  details: ApprovalDetails;
  inputs_hash: string;
  created_at: string;
  decided_at: string | null;
  case_title?: string;
}

export interface CaseSummary {
  done: string[];
  unconfirmed: string[];
  not_done: string[];
  follow_ups: string[];
  simulated_note: string;
}

export interface NextAction {
  kind: "question" | "approval" | "next" | "paused";
  step_id: string;
  text: string;
}

export interface Reasoning {
  mode: "deterministic" | "cloud";
  planner: string;
  model?: string;
  rationale?: string;
  notes: string[];
}

export interface CaseRecord {
  id: string;
  goal_type: GoalType;
  title: string;
  status: CaseStatus;
  status_label: string;
  goal: Goal;
  plan_version: number;
  reasoning: Reasoning;
  paused: boolean;
  summary: CaseSummary | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CaseDetail extends CaseRecord {
  steps: Step[];
  pending_approvals: Approval[];
  next_actions: NextAction[];
  counts: Record<string, number>;
  busy: boolean;
  automation_paused: boolean;
  last_event: { id: number; ts: string; kind: string; actor: string; message: string } | null;
}

export interface CaseListItem extends CaseRecord {
  progress: { done: number; total: number };
  pending_approvals: number;
}

export interface AuditEvent {
  id: number;
  case_id: string | null;
  step_id: string | null;
  ts: string;
  kind: string;
  actor: "user" | "agent" | "system" | "presenter";
  message: string;
  data: Record<string, unknown>;
}

export interface Invocation {
  id: string;
  step_id: string;
  tool: string;
  idempotency_key: string;
  attempt: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: { code: string; message: string } | null;
}

export interface Verification {
  id: string;
  step_id: string;
  passed: boolean;
  checks: VerificationCheck[];
  ts: string;
}

export interface Timeline {
  events: AuditEvent[];
  invocations: Invocation[];
  verifications: Verification[];
  approvals: Approval[];
}

export interface ReasoningStatus {
  mode: "deterministic" | "cloud" | "cloud_degraded";
  provider: string | null;
  model: string | null;
  state: "not_configured" | "configured" | "ok" | "error";
  description: string;
  last_ok_at?: string | null;
  last_error?: string | null;
  calls?: number;
}

export interface NodeInfo {
  role: string;
  hostname: string;
  system: string;
  machine: string;
  device_model: string | null;
  is_raspberry_pi: boolean;
  python: string;
}

export interface Health {
  status: "ok" | "degraded";
  version: string;
  time: string;
  started_at: string;
  node: NodeInfo;
  database: { ok: boolean; schema_version: number };
  reasoning: ReasoningStatus;
  automation_paused: boolean;
  auth_required: boolean;
  demo_controls: boolean;
}

export interface Integration {
  key: string;
  name: string;
  description: string;
  simulated: boolean;
  base_path: string;
  real_world_effects: boolean;
}

export interface Runtime {
  node: NodeInfo;
  database: { path: string; schema_version: number };
  reasoning: ReasoningStatus & {
    history?: { at: string; purpose: string; ok: boolean; error: string | null }[];
  };
  integrations: Integration[];
  automation_paused: boolean;
  held_on_start: string[];
  privacy: Record<string, string>;
  settings: {
    step_delay_ms: number;
    allowed_origins: string[];
    auth_required: boolean;
    demo_controls: boolean;
  };
}

export interface GoalCard {
  goal_type: GoalType | "resume";
  title: string;
  subtitle: string;
  icon: string;
}

export interface Suggestion {
  kind: "approvals" | "resume" | "goal";
  title: string;
  case_id?: string;
  goal_type?: GoalType;
  selections?: Record<string, string>;
}

export interface Catalog {
  cards: GoalCard[];
  phrases: { id: string; text: string }[];
  suggestions: Suggestion[];
}

export type InputMode = "gaze" | "head" | "scan_blink" | "scan_key" | "pointer";

export interface Preferences {
  input_mode: InputMode;
  dwell_ms: number;
  dwell_stability_px: number;
  target_snap_px: number;
  scan_interval_ms: number;
  blink_ms: number;
  text_scale: number;
  theme: "system" | "light" | "dark" | "contrast";
  reduced_motion: boolean;
  show_gaze_cursor: boolean;
  confirm_consequential: boolean;
  auto_fallback_to_scan: boolean;
  speak_feedback: boolean;
}

export interface Faults {
  repair_slot_taken: boolean;
  repair_timeout_after_commit: boolean;
  messaging_unavailable: boolean;
}

export interface ActivityEvent extends AuditEvent {
  case_title: string;
}
