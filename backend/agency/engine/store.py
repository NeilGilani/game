"""Persistence for cases, steps, approvals, invocations, verifications and audit events.

This module is the single source of truth for workflow state. The UI only ever displays
what is stored here; it never decides whether an action succeeded.
"""

from __future__ import annotations

import hashlib
import secrets
from typing import Any

from ..db import Database, dumps, loads, utcnow
from ..models import (
    CaseStatus,
    PlanDraft,
    StepDraft,
    StepStatus,
    VerificationResult,
    check_transition,
)


def inputs_hash(inputs: dict[str, Any]) -> str:
    return hashlib.sha256(dumps(inputs).encode()).hexdigest()[:24]


def _step_row(row: Any) -> dict[str, Any]:
    return {
        "case_id": row["case_id"],
        "id": row["id"],
        "position": row["position"],
        "plan_version": row["plan_version"],
        "kind": row["kind"],
        "title": row["title"],
        "description": row["description"],
        "tool": row["tool"],
        "inputs": loads(row["inputs"]),
        "depends_on": loads(row["depends_on"]),
        "preconditions": loads(row["preconditions"]),
        "approval": row["approval"],
        "optional": bool(row["optional"]),
        "status": row["status"],
        "expected_output": row["expected_output"],
        "verification": loads(row["verification"]),
        "retry": loads(row["retry"]),
        "timeout_s": row["timeout_s"],
        "attempts": row["attempts"],
        "question": loads(row["question"]),
        "output": loads(row["output"]),
        "error": loads(row["error"]),
        "evidence": loads(row["evidence"]),
        "idempotency_key": row["idempotency_key"],
        "recovery_of": row["recovery_of"],
        "recovery_context": loads(row["recovery_context"]),
        "updated_at": row["updated_at"],
    }


def _case_row(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "goal_type": row["goal_type"],
        "title": row["title"],
        "status": row["status"],
        "goal": loads(row["goal"]),
        "plan_version": row["plan_version"],
        "reasoning": loads(row["reasoning"]),
        "paused": bool(row["paused"]),
        "summary": loads(row["summary"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "completed_at": row["completed_at"],
    }


def _approval_row(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "case_id": row["case_id"],
        "step_id": row["step_id"],
        "status": row["status"],
        "summary": row["summary"],
        "details": loads(row["details"]),
        "inputs_hash": row["inputs_hash"],
        "created_at": row["created_at"],
        "decided_at": row["decided_at"],
        "decision_note": row["decision_note"],
    }


class Store:
    def __init__(self, db: Database) -> None:
        self.db = db

    # -- cases --------------------------------------------------------------------------
    def create_case(self, *, goal: dict[str, Any], title: str, reasoning: dict[str, Any], plan: PlanDraft) -> str:
        case_id = f"case_{secrets.token_hex(4)}"
        now = utcnow()
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO cases(id, goal_type, title, status, goal, plan_version, reasoning, paused,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (case_id, goal["goal_type"], title, CaseStatus.RUNNING.value, dumps(goal), 1, dumps(reasoning), 0, now, now),
            )
            self.insert_steps(case_id, plan.steps, plan_version=1, start_position=0)
        return case_id

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM cases WHERE id = ?", (case_id,))
        return _case_row(row) if row else None

    def list_cases(self) -> list[dict[str, Any]]:
        return [_case_row(r) for r in self.db.query("SELECT * FROM cases ORDER BY updated_at DESC")]

    def set_case(self, case_id: str, **fields: Any) -> None:
        if not fields:
            return
        assignments = []
        values: list[Any] = []
        for key, value in fields.items():
            if key in {"goal", "reasoning", "summary"}:
                value = dumps(value)
            elif key == "status" and isinstance(value, CaseStatus):
                value = value.value
            elif key == "paused":
                value = 1 if value else 0
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(utcnow())
        values.append(case_id)
        self.db.execute(f"UPDATE cases SET {', '.join(assignments)} WHERE id = ?", values)  # noqa: S608

    # -- steps --------------------------------------------------------------------------
    def insert_steps(
        self,
        case_id: str,
        drafts: list[StepDraft],
        *,
        plan_version: int,
        start_position: int,
        recovery_of: str | None = None,
        recovery_context: dict[str, Any] | None = None,
    ) -> None:
        now = utcnow()
        for offset, draft in enumerate(drafts):
            kind = "ask" if draft.tool == "user.ask" else "action"
            question = draft.question.model_dump() if draft.question else None
            self.db.execute(
                "INSERT INTO steps(case_id, id, position, plan_version, kind, title, description, tool, inputs,"
                " depends_on, preconditions, approval, optional, status, expected_output, verification, retry,"
                " timeout_s, attempts, question, idempotency_key, recovery_of, recovery_context, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    case_id,
                    draft.id,
                    start_position + offset,
                    plan_version,
                    kind,
                    draft.title,
                    draft.description,
                    draft.tool,
                    dumps(draft.inputs),
                    dumps(draft.depends_on),
                    dumps(draft.preconditions),
                    draft.approval,
                    1 if draft.optional else 0,
                    StepStatus.PENDING.value,
                    draft.expected_output,
                    dumps({"description": draft.verification}),
                    dumps(draft.retry.model_dump()),
                    draft.timeout_s,
                    0,
                    dumps(question) if question else None,
                    f"{case_id}:{draft.id}",
                    recovery_of,
                    dumps(recovery_context) if recovery_context else None,
                    now,
                ),
            )

    def get_steps(self, case_id: str) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM steps WHERE case_id = ? ORDER BY position", (case_id,))
        return [_step_row(r) for r in rows]

    def get_step(self, case_id: str, step_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM steps WHERE case_id = ? AND id = ?", (case_id, step_id))
        return _step_row(row) if row else None

    def update_step(self, case_id: str, step_id: str, **fields: Any) -> dict[str, Any]:
        current = self.get_step(case_id, step_id)
        if current is None:
            raise KeyError(step_id)
        if "status" in fields:
            new = StepStatus(fields["status"])
            old = StepStatus(current["status"])
            if new != old:
                check_transition(old, new)
            fields["status"] = new.value
        assignments = []
        values: list[Any] = []
        for key, value in fields.items():
            if key in {
                "inputs",
                "depends_on",
                "preconditions",
                "verification",
                "retry",
                "question",
                "output",
                "error",
                "evidence",
                "recovery_context",
            }:
                value = dumps(value) if value is not None else None
            elif key == "optional":
                value = 1 if value else 0
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(utcnow())
        values.extend([case_id, step_id])
        self.db.execute(f"UPDATE steps SET {', '.join(assignments)} WHERE case_id = ? AND id = ?", values)  # noqa: S608
        updated = self.get_step(case_id, step_id)
        assert updated is not None
        return updated

    def next_position(self, case_id: str) -> int:
        row = self.db.query_one("SELECT MAX(position) AS p FROM steps WHERE case_id = ?", (case_id,))
        return int(row["p"]) + 1 if row and row["p"] is not None else 0

    def shift_positions(self, case_id: str, from_position: int, by: int) -> None:
        self.db.execute(
            "UPDATE steps SET position = position + ? WHERE case_id = ? AND position >= ?", (by, case_id, from_position)
        )

    # -- invocations --------------------------------------------------------------------
    def start_invocation(self, *, case_id: str, step_id: str, tool: str, inputs: dict[str, Any], key: str, attempt: int) -> str:
        inv_id = f"inv_{secrets.token_hex(5)}"
        self.db.execute(
            "INSERT INTO invocations(id, case_id, step_id, tool, inputs, idempotency_key, attempt, status, started_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (inv_id, case_id, step_id, tool, dumps(inputs), key, attempt, "started", utcnow()),
        )
        return inv_id

    def finish_invocation(
        self, inv_id: str, *, status: str, result: dict[str, Any] | None, error: dict[str, Any] | None, duration_ms: int
    ) -> None:
        self.db.execute(
            "UPDATE invocations SET status = ?, result = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?",
            (
                status,
                dumps(result) if result is not None else None,
                dumps(error) if error is not None else None,
                utcnow(),
                duration_ms,
                inv_id,
            ),
        )

    def invocations(self, case_id: str, step_id: str | None = None) -> list[dict[str, Any]]:
        if step_id:
            rows = self.db.query(
                "SELECT * FROM invocations WHERE case_id = ? AND step_id = ? ORDER BY started_at", (case_id, step_id)
            )
        else:
            rows = self.db.query("SELECT * FROM invocations WHERE case_id = ? ORDER BY started_at", (case_id,))
        return [
            {
                "id": r["id"],
                "step_id": r["step_id"],
                "tool": r["tool"],
                "inputs": loads(r["inputs"]),
                "idempotency_key": r["idempotency_key"],
                "attempt": r["attempt"],
                "status": r["status"],
                "result": loads(r["result"]),
                "error": loads(r["error"]),
                "started_at": r["started_at"],
                "finished_at": r["finished_at"],
                "duration_ms": r["duration_ms"],
            }
            for r in rows
        ]

    def mark_open_invocations(self, case_id: str, step_id: str, status: str) -> None:
        self.db.execute(
            "UPDATE invocations SET status = ?, finished_at = ? WHERE case_id = ? AND step_id = ? AND status = 'started'",
            (status, utcnow(), case_id, step_id),
        )

    # -- approvals ----------------------------------------------------------------------
    def create_approval(self, *, case_id: str, step_id: str, summary: str, details: dict[str, Any], hash_: str) -> dict[str, Any]:
        approval_id = f"apr_{secrets.token_hex(4)}"
        self.db.execute(
            "INSERT INTO approvals(id, case_id, step_id, status, summary, details, inputs_hash, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (approval_id, case_id, step_id, "pending", summary, dumps(details), hash_, utcnow()),
        )
        approval = self.get_approval(approval_id)
        assert approval is not None
        return approval

    def get_approval(self, approval_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM approvals WHERE id = ?", (approval_id,))
        return _approval_row(row) if row else None

    def latest_approval(self, case_id: str, step_id: str) -> dict[str, Any] | None:
        row = self.db.query_one(
            "SELECT * FROM approvals WHERE case_id = ? AND step_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (case_id, step_id),
        )
        return _approval_row(row) if row else None

    def list_approvals(self, *, case_id: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM approvals WHERE 1=1"
        params: list[Any] = []
        if case_id:
            sql += " AND case_id = ?"
            params.append(case_id)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY created_at, rowid"
        return [_approval_row(r) for r in self.db.query(sql, params)]

    def decide_approval(self, approval_id: str, status: str, note: str | None = None) -> None:
        self.db.execute(
            "UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ?",
            (status, utcnow(), note, approval_id),
        )

    # -- verification & audit -----------------------------------------------------------
    def record_verification(self, *, case_id: str, step_id: str, invocation_id: str | None, result: VerificationResult) -> str:
        ver_id = f"ver_{secrets.token_hex(4)}"
        self.db.execute(
            "INSERT INTO verifications(id, case_id, step_id, invocation_id, passed, checks, ts) VALUES (?,?,?,?,?,?,?)",
            (
                ver_id,
                case_id,
                step_id,
                invocation_id,
                1 if result.passed else 0,
                dumps([c.model_dump() for c in result.checks]),
                utcnow(),
            ),
        )
        return ver_id

    def verifications(self, case_id: str) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM verifications WHERE case_id = ? ORDER BY ts", (case_id,))
        return [
            {
                "id": r["id"],
                "step_id": r["step_id"],
                "invocation_id": r["invocation_id"],
                "passed": bool(r["passed"]),
                "checks": loads(r["checks"]),
                "ts": r["ts"],
            }
            for r in rows
        ]

    def audit(
        self,
        case_id: str | None,
        kind: str,
        message: str,
        *,
        actor: str = "agent",
        step_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        self.db.execute(
            "INSERT INTO audit_events(case_id, step_id, ts, kind, actor, message, data) VALUES (?,?,?,?,?,?,?)",
            (case_id, step_id, utcnow(), kind, actor, message, dumps(data or {})),
        )

    def last_audit(self, case_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM audit_events WHERE case_id = ? ORDER BY id DESC LIMIT 1", (case_id,))
        if not row:
            return None
        return {"id": row["id"], "ts": row["ts"], "kind": row["kind"], "actor": row["actor"], "message": row["message"]}

    def audit_events(self, case_id: str | None = None, *, after_id: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        if case_id:
            rows = self.db.query(
                "SELECT * FROM audit_events WHERE case_id = ? AND id > ? ORDER BY id LIMIT ?", (case_id, after_id, limit)
            )
        else:
            rows = self.db.query("SELECT * FROM audit_events WHERE id > ? ORDER BY id DESC LIMIT ?", (after_id, limit))
        return [
            {
                "id": r["id"],
                "case_id": r["case_id"],
                "step_id": r["step_id"],
                "ts": r["ts"],
                "kind": r["kind"],
                "actor": r["actor"],
                "message": r["message"],
                "data": loads(r["data"]),
            }
            for r in rows
        ]
