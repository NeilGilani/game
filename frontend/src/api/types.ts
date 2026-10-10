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
  label?: string | null;
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

export interface WorkflowInsights {
  server_time: string;
  cases_completed: number;
  steps_verified: number;
  actions_verified: number;
  approved_decisions: number;
  recovery_steps_verified: number;
  cloud_plans: number;
  tool_calls: number;
  verification_passes: number;
}

export interface ReasoningStatus {
  mode: "deterministic" | "cloud" | "cloud_degraded";
  provider: string | null;
  /** Display name of the cloud model family ("Gemini", "Claude"), or null in deterministic mode. */
  label?: string | null;
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
  lifeline_primary_unreachable: boolean;
  lifeline_power_cut: boolean;
}

export interface ActivityEvent extends AuditEvent {
  case_title: string;
}

// -- Lifeline ---------------------------------------------------------------------------

export type ContactRole = "caregiver" | "family" | "neighbour" | "clinician" | "monitoring_service" | "other";
export type LifelineChannel = "demo" | "sms" | "sms_call";
export type AlertKind = "help" | "watchdog" | "checkin_missed" | "signal_unavailable" | "power_lost";
export type Situation = "breathing" | "choking" | "equipment" | "pain" | "position" | "other";
export type PlanKey = "general" | Situation;
export type Urgency = "standard" | "urgent" | "critical";
export type EyeAnswer = "yes" | "no" | "not_sure";
export type HelpSource = "eye_signal" | "help_button" | "switch" | "test";
export type AlertStatus = "pending_cancel" | "active" | "acknowledged" | "resolved" | "cancelled";

export interface LifelineContact {
  id: string;
  name: string;
  role: ContactRole;
  channel: LifelineChannel;
  address: string;
  priority: number;
  enabled: boolean;
}

export interface ResponderCard {
  person_name: string;
  address: string;
  communication: string;
  breathing: string;
  medical: string;
  allergies: string;
  medications: string;
  advance_directive: string;
  notes: string;
}

export interface DispatchAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export interface DispatchSettings {
  consent: boolean;
  consented_at: string | null;
  auto_after_s: number;
  address: DispatchAddress;
  phone: string;
  entry: string;
  pin: string;
}

export interface HomeSettings {
  lights_on_alert: boolean;
  unlock_for_responders: boolean;
  unlock_for_emergency_services: boolean;
  relock_after_min: number;
  watch_power: boolean;
  power_critical_minutes: number;
}

export interface LifelineSettings {
  consent: boolean;
  consent_note: string;
  consented_at: string | null;
  contacts: LifelineContact[];
  cancel_window_s: number;
  ack_timeout_s: number;
  watchdog_timeout_s: number;
  checkin_interval_min: number;
  checkin_response_s: number;
  alert_on_signal_unavailable: boolean;
  signal_grace_s: number;
  responder: ResponderCard;
  emergency_number: string;
  critical_alert_everyone: boolean;
  plans: Partial<Record<PlanKey, string[]>>;
  plans_note: string;
  dispatch: DispatchSettings;
  home: HomeSettings;
}

export interface LifelineNotification {
  id: string;
  alert_id: string;
  contact_id: string;
  contact_name: string;
  contact_role: ContactRole;
  channel: LifelineChannel;
  purpose: "alert" | "stand_down" | "all_clear" | "update";
  level: number;
  cycle: number;
  status: "sending" | "delivered" | "sent" | "failed";
  body: string;
  error: string | null;
  response: "acknowledged" | "declined" | "resolved" | null;
  responded_at: string | null;
  created_at: string;
  sent_at: string | null;
  has_link: boolean;
}

export interface LifelineEvent {
  id: number;
  ts: string;
  kind: string;
  actor: "user" | "system" | "contact";
  message: string;
  data: Record<string, unknown>;
}

export interface AlertMetrics {
  seconds_to_first_contact: number | null;
  seconds_to_acknowledged: number | null;
  people_alerted: number;
}

export interface AlertSummary {
  id: string;
  kind: AlertKind;
  source: string;
  is_test: boolean;
  status: AlertStatus;
  message: string;
  what: string;
  created_at: string;
  activates_at: string;
  activated_at: string | null;
  level: number;
  cycle: number;
  next_escalation_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  local_only: boolean;
  metrics: AlertMetrics;
  situation: Situation | null;
  urgency: Urgency;
  critical_since: string | null;
  detail: string | null;
}

export interface EyeQuestion {
  id: string;
  alert_id: string;
  contact_id: string | null;
  asked_by: string;
  text: string;
  answer: EyeAnswer | null;
  asked_at: string;
  answered_at: string | null;
}

export interface PlanStep {
  index: number;
  key: string;
  label: string;
  done_by: string | null;
  done_at: string | null;
}

export interface DispatchView {
  id: string;
  status: "requested" | "accepted" | "failed" | "cancelled" | "test_skipped" | "not_allowed";
  provider: string;
  simulated: boolean;
  reason: string;
  requested_by: string;
  provider_ref: string | null;
  error: string | null;
  note: string | null;
  requested_at: string;
  active: boolean;
  summary: string;
}

export interface AlertDetail extends AlertSummary {
  notifications: LifelineNotification[];
  events: LifelineEvent[];
  waiting_on: string[];
  situation_label: string;
  questions: EyeQuestion[];
  pending_question: EyeQuestion | null;
  plan: { key: PlanKey; label: string; steps: PlanStep[] };
  plans_note: string;
  dispatch: DispatchView | null;
  arrivals: { contact_id: string; contact_name: string; arrived_at: string }[];
  door_unlocked_for: string | null;
  door_relocks_at: string | null;
  handoff: { label: string; text: string }[];
}

export interface LifelineMonitor {
  armed: boolean;
  armed_at: string | null;
  last_heartbeat_at: string | null;
  seconds_since_heartbeat: number | null;
  last_heartbeat: HeartbeatBody | null;
  signal_unready_since: string | null;
  next_checkin_at: string | null;
  checkin_pending_since: string | null;
  checkin_last_ok_at: string | null;
}

export interface LifelineStatus {
  server_time: string;
  settings: LifelineSettings;
  ready: boolean;
  problems: string[];
  channels: { twilio_configured: boolean; public_url: string };
  monitor: LifelineMonitor;
  open_alert: AlertDetail | null;
  recent: AlertSummary[];
  rescue: {
    situations: { key: Situation; label: string; urgency: Urgency }[];
    questions: { key: string; text: string }[];
  };
  dispatch: { provider: string; simulated: boolean; sandbox: boolean; ready: boolean };
  home: {
    provider: string;
    simulated: boolean;
    has_lock: boolean;
    has_lights: boolean;
    has_power: boolean;
    state: {
      door: string | null;
      lights: string | null;
      power: { mains: boolean | null; battery_minutes: number | null };
    } | null;
  };
}

export interface OutboxMessage {
  id: string;
  alert_id: string;
  contact_id: string;
  contact_name: string;
  purpose: "alert" | "stand_down" | "all_clear" | "update";
  status: string;
  body: string;
  created_at: string;
  response: string | null;
  alert_status: AlertStatus;
  is_test: boolean;
  link: string | null;
}

export interface LifelineReport {
  alerts: number;
  tests: number;
  real: number;
  cancelled_in_countdown: number;
  acknowledged: number;
  local_only: number;
  open: number;
  median_seconds_to_acknowledged: number | null;
  max_seconds_to_acknowledged: number | null;
  by_kind: Record<AlertKind, number>;
  emergency_services_requested: number;
}

export interface HeartbeatBody {
  signal_ready: boolean;
  camera: string;
  face_visible: boolean;
  page_visible: boolean;
  input_mode: string;
}
