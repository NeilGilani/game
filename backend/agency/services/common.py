"""Shared pieces for the demonstration integration services.

Each demo service owns its own tables (prefixed ``svc_``) and is only reached through its
adapter class. The workflow engine never reads or writes those tables directly, so a real
provider adapter can replace a demo one without touching the planner or executor.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any

from ..db import Database


class ServiceError(Exception):
    """A structured failure returned by an integration (the equivalent of an HTTP error)."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 400,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable
        self.details = details or {}


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def new_reference(prefix: str) -> str:
    return f"{prefix}-{secrets.randbelow(9000) + 1000}"


@dataclass
class Faults:
    """Presenter-controlled fault injection, persisted so it survives restarts."""

    db: Database

    def snapshot(self) -> dict[str, Any]:
        faults: dict[str, Any] = self.db.get_state("faults", {}) or {}
        return {
            "repair_slot_taken": bool(faults.get("repair_slot_taken")),
            "repair_timeout_after_commit": bool(faults.get("repair_timeout_after_commit")),
            "messaging_unavailable": int(faults.get("messaging_unavailable_remaining", 0)) > 0,
        }

    def configure(self, values: dict[str, bool]) -> dict[str, Any]:
        faults: dict[str, Any] = self.db.get_state("faults", {}) or {}
        if "repair_slot_taken" in values:
            faults["repair_slot_taken"] = bool(values["repair_slot_taken"])
        if "repair_timeout_after_commit" in values:
            faults["repair_timeout_after_commit"] = bool(values["repair_timeout_after_commit"])
        if "messaging_unavailable" in values:
            # Enough consecutive failures to exhaust one step's retry budget.
            faults["messaging_unavailable_remaining"] = 2 if values["messaging_unavailable"] else 0
        self.db.set_state("faults", faults)
        return self.snapshot()

    def consume(self, name: str) -> bool:
        """Return True (and disarm) if a one-shot fault is armed."""
        faults: dict[str, Any] = self.db.get_state("faults", {}) or {}
        if faults.get(name):
            faults[name] = False
            self.db.set_state("faults", faults)
            return True
        return False

    def consume_counted(self, name: str) -> bool:
        faults: dict[str, Any] = self.db.get_state("faults", {}) or {}
        remaining = int(faults.get(f"{name}_remaining", 0))
        if remaining > 0:
            faults[f"{name}_remaining"] = remaining - 1
            self.db.set_state("faults", faults)
            return True
        return False


@dataclass(frozen=True)
class IntegrationInfo:
    key: str
    name: str
    description: str
    simulated: bool
    base_path: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "description": self.description,
            "simulated": self.simulated,
            "base_path": self.base_path,
            "real_world_effects": False if self.simulated else True,
        }


INTEGRATIONS: list[IntegrationInfo] = [
    IntegrationInfo(
        "repair",
        "Demo Repair Provider",
        "A simulated mobility-equipment repair shop with technicians and appointment slots.",
        True,
        "/api/demo-services/repair",
    ),
    IntegrationInfo(
        "funding",
        "Demo Funding Service",
        "A simulated assistance program and benefits office. It never approves funding by itself.",
        True,
        "/api/demo-services/funding",
    ),
    IntegrationInfo(
        "calendar",
        "Demo Calendar",
        "A simulated personal calendar plus a demo clinic's open appointment times.",
        True,
        "/api/demo-services/calendar",
    ),
    IntegrationInfo(
        "messaging",
        "Demo Messaging Service",
        "A simulated outbox. Messages are stored here and are never delivered to real people.",
        True,
        "/api/demo-services/messaging",
    ),
]
