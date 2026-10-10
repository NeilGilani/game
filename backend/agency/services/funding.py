"""Demo Funding Service: a simulated assistance program and benefits office.

It records inquiries and applications and issues reference numbers. It never decides an
inquiry on its own: ``decision`` stays ``None`` so nothing in AGENCY can claim funding
was approved.
"""

from __future__ import annotations

from typing import Any

from ..db import Database, dumps, loads, utcnow
from .common import Faults, ServiceError, new_id, new_reference


class DemoFundingService:
    name = "Demo Funding Service"
    simulated = True

    def __init__(self, db: Database, faults: Faults) -> None:
        self.db = db
        self.faults = faults

    # -- programs and forms --------------------------------------------------------------
    def list_programs(self) -> list[dict[str, Any]]:
        return [loads(r["data"]) for r in self.db.query("SELECT data FROM svc_funding_programs ORDER BY id")]

    def get_policy(self, *, device_category: str, service: str) -> dict[str, Any] | None:
        wanted = f"{device_category}_{service}"
        for program in self.list_programs():
            if program.get("kind") == "program" and wanted in program.get("covers", []):
                return program
        return None

    def list_forms(self) -> list[dict[str, Any]]:
        return [p for p in self.list_programs() if p.get("kind") == "form"]

    def get_form(self, form_id: str) -> dict[str, Any] | None:
        for form in self.list_forms():
            if form["id"] == form_id:
                return form
        return None

    # -- cases (inquiries and applications) ----------------------------------------------
    def get_case(self, case_ref: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_funding_cases WHERE id = ? OR reference = ?", (case_ref, case_ref))
        return self._case(row) if row else None

    def find_by_key(self, idempotency_key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_funding_cases WHERE idempotency_key = ?", (idempotency_key,))
        return self._case(row) if row else None

    def find_submission(self, idempotency_key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_funding_submissions WHERE idempotency_key = ?", (idempotency_key,))
        return self.get_case(row["case_ref"]) if row else None

    def list_cases(self) -> list[dict[str, Any]]:
        return [self._case(r) for r in self.db.query("SELECT * FROM svc_funding_cases ORDER BY created_at")]

    def create_draft(
        self,
        *,
        idempotency_key: str,
        kind: str,
        program_id: str | None,
        form_id: str | None,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        existing = self.find_by_key(idempotency_key)
        if existing:
            return existing, True
        if kind not in {"inquiry", "application"}:
            raise ServiceError("invalid_kind", "Unknown request kind.")
        if kind == "application" and (not form_id or not self.get_form(form_id)):
            raise ServiceError("unknown_form", f"Form {form_id} does not exist.", status=404)
        case_id = new_id("fc")
        self.db.execute(
            "INSERT INTO svc_funding_cases(id, idempotency_key, kind, status, program_id, form_id,"
            " payload, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (case_id, idempotency_key, kind, "draft", program_id, form_id, dumps(payload), utcnow()),
        )
        created = self.get_case(case_id)
        assert created is not None
        return created, False

    def submit(self, *, idempotency_key: str, case_id: str) -> dict[str, Any]:
        previous = self.find_submission(idempotency_key)
        if previous:
            return {"case": previous, "replayed": True}
        record = self.get_case(case_id)
        if not record:
            raise ServiceError("unknown_case", f"Draft {case_id} not found.", status=404)
        if record["status"] != "draft":
            raise ServiceError("not_a_draft", "Only drafts can be submitted.", status=409)
        prefix = "DFS" if record["kind"] == "inquiry" else "DBO"
        reference = new_reference(prefix)
        with self.db.transaction():
            self.db.execute(
                "UPDATE svc_funding_cases SET status = 'received', reference = ?, submitted_at = ? WHERE id = ?",
                (reference, utcnow(), case_id),
            )
            self.db.execute(
                "INSERT INTO svc_funding_submissions(idempotency_key, case_ref, created_at) VALUES (?,?,?)",
                (idempotency_key, case_id, utcnow()),
            )
        submitted = self.get_case(case_id)
        assert submitted is not None
        return {"case": submitted, "replayed": False}

    @staticmethod
    def _case(row: Any) -> dict[str, Any]:
        return {
            "case_id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "program_id": row["program_id"],
            "form_id": row["form_id"],
            "payload": loads(row["payload"]),
            "reference": row["reference"],
            "decision": row["decision"],
            "created_at": row["created_at"],
            "submitted_at": row["submitted_at"],
        }
