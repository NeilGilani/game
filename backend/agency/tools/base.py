"""Tool contracts: every action the agent can take is a ToolSpec with a typed input model.

The planner (deterministic or cloud) can only name tools that exist here, and the executor
validates every input against the tool's model before anything runs.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from ..models import RetryPolicy, ToolError, ToolResult, VerificationCheck, VerificationResult

if TYPE_CHECKING:
    from ..db import Database
    from ..services.calendar import DemoCalendar
    from ..services.funding import DemoFundingService
    from ..services.messaging import DemoMessagingService
    from ..services.repair import DemoRepairProvider


@dataclass
class ToolContext:
    db: Database
    repair: DemoRepairProvider
    funding: DemoFundingService
    calendar: DemoCalendar
    messaging: DemoMessagingService
    profile: dict[str, Any]
    case_id: str = ""
    step_id: str = ""
    idempotency_key: str = ""
    step_outputs: dict[str, Any] = field(default_factory=dict)


@dataclass
class ActionSummary:
    """Plain-language description of a consequential action, shown before approval."""

    headline: str
    details: list[tuple[str, str]]
    effect: str
    if_rejected: str
    reversible: str
    edit: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "headline": self.headline,
            "details": [{"label": k, "value": v} for k, v in self.details],
            "effect": self.effect,
            "if_rejected": self.if_rejected,
            "reversible": self.reversible,
            "edit": self.edit,
        }


RunFn = Callable[[ToolContext, Any], Awaitable[ToolResult]]
VerifyFn = Callable[[ToolContext, Any, ToolResult], VerificationResult]
LookupFn = Callable[[ToolContext, Any], ToolResult | None]
DescribeFn = Callable[[ToolContext, Any], ActionSummary]
EditFn = Callable[[ToolContext, Any, dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    title: str
    description: str
    input_model: type[BaseModel]
    output_keys: tuple[str, ...]
    integration: str  # "repair" | "funding" | "calendar" | "messaging" | "agency"
    consequential: bool
    run: RunFn
    verify: VerifyFn | None = None
    lookup: LookupFn | None = None
    describe: DescribeFn | None = None
    apply_edit: EditFn | None = None
    reversible: str = ""
    timeout_s: float = 6.0
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    read_only: bool = False

    def catalog_entry(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "integration": self.integration,
            "consequential": self.consequential,
            "read_only": self.read_only,
            "input_schema": self.input_model.model_json_schema(),
            "output_keys": list(self.output_keys),
        }


# -- result helpers -------------------------------------------------------------------------


def ok(message: str, data: dict[str, Any], evidence: dict[str, Any] | None = None, *, replayed: bool = False) -> ToolResult:
    return ToolResult(ok=True, message=message, data=data, evidence=evidence or {}, replayed=replayed)


def fail(code: str, message: str, *, retryable: bool = False, details: dict[str, Any] | None = None) -> ToolResult:
    return ToolResult(
        ok=False,
        message=message,
        error=ToolError(code=code, message=message, retryable=retryable, details=details or {}),
    )


def checks_result(checks: list[VerificationCheck], ok_summary: str, fail_summary: str) -> VerificationResult:
    passed = all(c.passed for c in checks)
    return VerificationResult(passed=passed, checks=checks, summary=ok_summary if passed else fail_summary)


def check(name: str, expected: Any, observed: Any) -> VerificationCheck:
    return VerificationCheck(name=name, passed=expected == observed, expected=expected, observed=observed)


# -- formatting -----------------------------------------------------------------------------


def when(value: str | None) -> str:
    """'2026-10-13T09:00' -> 'Tue Oct 13, 9:00 AM'."""
    if not value:
        return "an unknown time"
    dt = datetime.fromisoformat(value)
    hour = dt.hour % 12 or 12
    suffix = "AM" if dt.hour < 12 else "PM"
    return f"{dt:%a %b} {dt.day}, {hour}:{dt.minute:02d} {suffix}"


def money(cents: int | None) -> str:
    if cents is None:
        return "unknown"
    return f"${cents / 100:,.2f}"
