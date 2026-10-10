"""Typed data models shared by the planner, executor, API and persistence layers."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------------------
# Status enums and the transitions the engine is allowed to make
# ---------------------------------------------------------------------------------------


class CaseStatus(StrEnum):
    PLANNING = "planning"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    WAITING_APPROVAL = "waiting_approval"
    NEEDS_ATTENTION = "needs_attention"
    PAUSED = "paused"
    INTERRUPTED = "interrupted"
    COMPLETED = "completed"
    COMPLETED_PARTIAL = "completed_partial"
    CANCELLED = "cancelled"


ACTIVE_CASE_STATUSES = {
    CaseStatus.PLANNING,
    CaseStatus.RUNNING,
    CaseStatus.WAITING_INPUT,
    CaseStatus.WAITING_APPROVAL,
    CaseStatus.NEEDS_ATTENTION,
    CaseStatus.PAUSED,
    CaseStatus.INTERRUPTED,
}


class StepStatus(StrEnum):
    PENDING = "pending"  # planned, not started
    WAITING_INPUT = "waiting_input"  # needs an answer from the user
    AWAITING_APPROVAL = "awaiting_approval"  # consequential, waiting for a decision
    APPROVED = "approved"  # user approved; not yet attempted
    RUNNING = "running"  # attempt in flight
    RETRYING = "retrying"  # transient failure, another attempt scheduled
    SUCCEEDED = "succeeded"  # tool reported success, verification pending
    VERIFIED = "verified"  # success confirmed against the service's own records
    FAILED = "failed"
    REJECTED = "rejected"  # user said no
    SKIPPED = "skipped"
    SUPERSEDED = "superseded"  # replaced by a recovery step
    BLOCKED = "blocked"  # a dependency can no longer complete
    CANCELLED = "cancelled"


DONE_STEP_STATUSES = {StepStatus.VERIFIED, StepStatus.SKIPPED}
TERMINAL_STEP_STATUSES = {
    StepStatus.VERIFIED,
    StepStatus.FAILED,
    StepStatus.REJECTED,
    StepStatus.SKIPPED,
    StepStatus.SUPERSEDED,
    StepStatus.BLOCKED,
    StepStatus.CANCELLED,
}

STEP_TRANSITIONS: dict[StepStatus, set[StepStatus]] = {
    StepStatus.PENDING: {
        StepStatus.WAITING_INPUT,
        StepStatus.AWAITING_APPROVAL,
        StepStatus.RUNNING,
        StepStatus.SKIPPED,
        StepStatus.BLOCKED,
        StepStatus.CANCELLED,
        StepStatus.FAILED,
    },
    StepStatus.WAITING_INPUT: {
        StepStatus.VERIFIED,
        StepStatus.SKIPPED,
        StepStatus.CANCELLED,
        StepStatus.BLOCKED,
        StepStatus.FAILED,
    },
    StepStatus.AWAITING_APPROVAL: {
        StepStatus.APPROVED,
        StepStatus.REJECTED,
        StepStatus.AWAITING_APPROVAL,  # re-requested after an edit
        StepStatus.SUPERSEDED,
        StepStatus.CANCELLED,
        StepStatus.BLOCKED,
    },
    StepStatus.APPROVED: {
        StepStatus.RUNNING,
        StepStatus.AWAITING_APPROVAL,
        StepStatus.CANCELLED,
        StepStatus.FAILED,
    },
    StepStatus.RUNNING: {
        StepStatus.SUCCEEDED,
        StepStatus.FAILED,
        StepStatus.RETRYING,
        StepStatus.APPROVED,  # interrupted attempt that never reached the service
        StepStatus.PENDING,
    },
    StepStatus.RETRYING: {
        StepStatus.RUNNING,
        StepStatus.FAILED,
        StepStatus.CANCELLED,
        StepStatus.PENDING,  # restart recovery
        StepStatus.APPROVED,
        StepStatus.SUCCEEDED,
    },
    StepStatus.SUCCEEDED: {StepStatus.VERIFIED, StepStatus.FAILED},
    StepStatus.FAILED: {StepStatus.SUPERSEDED, StepStatus.SKIPPED, StepStatus.CANCELLED},
    StepStatus.REJECTED: {StepStatus.SUPERSEDED, StepStatus.CANCELLED},
    StepStatus.BLOCKED: {StepStatus.PENDING, StepStatus.CANCELLED, StepStatus.SKIPPED},
    StepStatus.VERIFIED: set(),
    StepStatus.SKIPPED: set(),
    StepStatus.SUPERSEDED: set(),
    StepStatus.CANCELLED: set(),
}


class InvalidTransition(RuntimeError):
    pass


def check_transition(current: StepStatus, new: StepStatus) -> None:
    if new not in STEP_TRANSITIONS[current]:
        raise InvalidTransition(f"step cannot move from {current.value} to {new.value}")


# ---------------------------------------------------------------------------------------
# Goals
# ---------------------------------------------------------------------------------------

GoalType = Literal["equipment_repair", "reschedule_appointment", "admin_request", "message_followup"]


class Goal(BaseModel):
    """Structured representation of what the user wants. Validated before it enters state."""

    model_config = ConfigDict(extra="forbid")

    goal_type: GoalType
    outcome: str = Field(min_length=3, max_length=400)
    deadline: str | None = Field(default=None, description="ISO date (YYYY-MM-DD)")
    preferences: dict[str, str] = Field(default_factory=dict)
    entities: dict[str, str] = Field(default_factory=dict)
    constraints: list[str] = Field(default_factory=list)
    missing_info: list[str] = Field(default_factory=list)
    approvals_required: list[str] = Field(default_factory=list)
    prohibited: list[str] = Field(default_factory=list)
    options: dict[str, bool] = Field(default_factory=dict)

    @field_validator("deadline")
    @classmethod
    def _deadline_is_date(cls, value: str | None) -> str | None:
        if value is None:
            return value
        from datetime import date

        date.fromisoformat(value)
        return value

    @field_validator("preferences", "entities")
    @classmethod
    def _bounded_strings(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 20:
            raise ValueError("too many entries")
        for k, v in value.items():
            if len(k) > 60 or len(v) > 300:
                raise ValueError("entry too long")
        return value


class GoalRequest(BaseModel):
    """What the interface sends: a goal card, a few selections, optionally a typed phrase."""

    model_config = ConfigDict(extra="forbid")

    goal_type: GoalType | None = None
    selections: dict[str, str] = Field(default_factory=dict)
    phrases: list[str] = Field(default_factory=list, max_length=12)
    free_text: str | None = Field(default=None, max_length=600)


# ---------------------------------------------------------------------------------------
# Plans
# ---------------------------------------------------------------------------------------


class RetryPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_attempts: int = Field(default=2, ge=1, le=4)
    backoff_ms: int = Field(default=400, ge=0, le=10_000)


class QuestionOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str = Field(max_length=80)
    label: str = Field(max_length=120)
    description: str = Field(default="", max_length=240)


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(max_length=60)
    prompt: str = Field(max_length=240)
    options: list[QuestionOption] = Field(min_length=2, max_length=6)


class StepDraft(BaseModel):
    """A planned step as produced by a planner, before it is persisted."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,40}$")
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=3, max_length=400)
    tool: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    preconditions: list[dict[str, Any]] = Field(default_factory=list)
    approval: Literal["none", "required"] = "none"
    optional: bool = False
    expected_output: str = Field(default="", max_length=240)
    verification: str = Field(default="", max_length=240)
    retry: RetryPolicy = Field(default_factory=RetryPolicy)
    timeout_s: float = Field(default=8.0, gt=0, le=60)
    question: Question | None = None


class PlanDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    steps: list[StepDraft] = Field(min_length=1, max_length=24)
    rationale: str = Field(default="", max_length=800)


# ---------------------------------------------------------------------------------------
# Tool contracts
# ---------------------------------------------------------------------------------------


class ToolError(BaseModel):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] = Field(default_factory=dict)


class ToolResult(BaseModel):
    ok: bool
    message: str
    data: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)
    error: ToolError | None = None
    replayed: bool = False


class VerificationCheck(BaseModel):
    name: str
    passed: bool
    expected: Any = None
    observed: Any = None


class VerificationResult(BaseModel):
    passed: bool
    checks: list[VerificationCheck]
    summary: str


# ---------------------------------------------------------------------------------------
# API payloads
# ---------------------------------------------------------------------------------------


class CreateCaseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: Goal
    use_cloud_plan: bool = True


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str = Field(max_length=80)


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "reject"]
    edits: dict[str, Any] | None = None
    note: str | None = Field(default=None, max_length=300)


class BatchDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approval_ids: list[str] = Field(min_length=1, max_length=12)
    decision: Literal["approve", "reject"]


class EditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edits: dict[str, Any]


class Preferences(BaseModel):
    """Accessibility and interaction preferences. Contains no biometric data."""

    model_config = ConfigDict(extra="forbid")

    input_mode: Literal["gaze", "head", "scan_blink", "scan_key", "pointer"] = "pointer"
    dwell_ms: int = Field(default=1200, ge=400, le=4000)
    dwell_stability_px: int = Field(default=60, ge=10, le=300)
    target_snap_px: int = Field(default=48, ge=0, le=200)
    scan_interval_ms: int = Field(default=1500, ge=500, le=5000)
    blink_ms: int = Field(default=450, ge=200, le=1500)
    text_scale: float = Field(default=1.0, ge=0.85, le=1.6)
    theme: Literal["system", "light", "dark", "contrast"] = "system"
    reduced_motion: bool = False
    show_gaze_cursor: bool = True
    confirm_consequential: bool = True
    auto_fallback_to_scan: bool = True
    speak_feedback: bool = False


class FaultConfig(BaseModel):
    """Presenter-only switches that make a demo integration misbehave on purpose."""

    model_config = ConfigDict(extra="forbid")

    repair_slot_taken: bool = False
    repair_timeout_after_commit: bool = False
    messaging_unavailable: bool = False
