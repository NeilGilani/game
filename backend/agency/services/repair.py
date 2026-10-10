"""Demo Repair Provider: a simulated mobility-equipment repair shop."""

from __future__ import annotations

from typing import Any

from ..db import Database, dumps, loads, utcnow
from .common import Faults, ServiceError, new_id, new_reference

ESTIMATES_CENTS = {
    "battery": 38_500,
    "controls": 52_000,
    "wheel": 21_000,
    "seating": 27_500,
    "other": 30_000,
}


class DemoRepairProvider:
    name = "Demo Repair Provider"
    simulated = True

    def __init__(self, db: Database, faults: Faults) -> None:
        self.db = db
        self.faults = faults

    # -- reads ---------------------------------------------------------------------------
    def list_slots(self, *, include_booked: bool = True) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM svc_repair_slots ORDER BY starts_at")
        slots = [self._slot(r) for r in rows]
        return slots if include_booked else [s for s in slots if s["status"] == "open"]

    def search_slots(self, *, issue: str, before: str | None, limit: int = 4) -> dict[str, Any]:
        slots = [s for s in self.list_slots(include_booked=False)]
        if before:
            slots = [s for s in slots if s["starts_at"][:10] < before]
        estimate = ESTIMATES_CENTS.get(issue, ESTIMATES_CENTS["other"])
        return {"slots": slots[:limit], "estimate_cents": estimate, "searched_before": before}

    def get_slot(self, slot_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_repair_slots WHERE id = ?", (slot_id,))
        return self._slot(row) if row else None

    def get_request(self, request_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_repair_requests WHERE id = ?", (request_id,))
        return self._request(row) if row else None

    def find_submission(self, idempotency_key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_repair_submissions WHERE idempotency_key = ?", (idempotency_key,))
        if not row:
            return None
        return self.get_request(row["request_id"])

    def find_draft(self, idempotency_key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_repair_requests WHERE idempotency_key = ?", (idempotency_key,))
        return self._request(row) if row else None

    def list_requests(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM svc_repair_requests ORDER BY created_at")
        return [self._request(r) for r in rows]

    # -- writes --------------------------------------------------------------------------
    def create_draft(
        self, *, idempotency_key: str, device: dict[str, Any], issue: str, slot_id: str | None
    ) -> tuple[dict[str, Any], bool]:
        existing = self.find_draft(idempotency_key)
        if existing:
            return existing, True
        if slot_id and not self.get_slot(slot_id):
            raise ServiceError("unknown_slot", f"Slot {slot_id} does not exist.", status=404)
        request_id = new_id("rr")
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO svc_repair_requests(id, idempotency_key, status, device, issue, slot_id,"
                " estimate_cents, reference, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    request_id,
                    idempotency_key,
                    "draft",
                    dumps(device),
                    issue,
                    slot_id,
                    ESTIMATES_CENTS.get(issue, ESTIMATES_CENTS["other"]),
                    None,
                    utcnow(),
                ),
            )
        request = self.get_request(request_id)
        assert request is not None
        return request, False

    def submit(self, *, idempotency_key: str, request_id: str, slot_id: str) -> dict[str, Any]:
        """Book the slot and confirm the request. Safe to call again with the same key."""
        previous = self.find_submission(idempotency_key)
        if previous:
            return {"request": previous, "replayed": True, "slow": False}
        request = self.get_request(request_id)
        if not request:
            raise ServiceError("unknown_request", f"Repair request {request_id} not found.", status=404)
        if request["status"] == "confirmed" and request["slot_id"] != slot_id:
            raise ServiceError(
                "already_confirmed",
                "This repair request is already confirmed for a different time.",
                status=409,
            )
        slot = self.get_slot(slot_id)
        if not slot:
            raise ServiceError("unknown_slot", f"Slot {slot_id} does not exist.", status=404)

        if slot["status"] == "open" and self.faults.consume("repair_slot_taken"):
            # Presenter fault: another customer books this slot a moment before we do.
            self.db.execute(
                "UPDATE svc_repair_slots SET status = 'booked', booked_request_id = NULL,"
                " note = 'Booked by another customer' WHERE id = ?",
                (slot_id,),
            )
            slot = self.get_slot(slot_id)
            assert slot is not None

        if slot["status"] != "open":
            raise ServiceError(
                "slot_unavailable",
                "That appointment time is no longer available.",
                status=409,
                details={"slot_id": slot_id, "slot_status": slot["status"]},
            )

        reference = new_reference("DRP")
        with self.db.transaction():
            self.db.execute(
                "UPDATE svc_repair_slots SET status = 'booked', booked_request_id = ? WHERE id = ?",
                (request_id, slot_id),
            )
            self.db.execute(
                "UPDATE svc_repair_requests SET status = 'confirmed', slot_id = ?, reference = ?, confirmed_at = ? WHERE id = ?",
                (slot_id, reference, utcnow(), request_id),
            )
            self.db.execute(
                "INSERT INTO svc_repair_submissions(idempotency_key, request_id, slot_id, created_at) VALUES (?,?,?,?)",
                (idempotency_key, request_id, slot_id, utcnow()),
            )
        confirmed = self.get_request(request_id)
        assert confirmed is not None
        # Presenter fault: the booking is committed but the response is very slow, so the
        # caller times out without knowing whether it worked.
        slow = self.faults.consume("repair_timeout_after_commit")
        return {"request": confirmed, "replayed": False, "slow": slow}

    # -- row mapping ---------------------------------------------------------------------
    @staticmethod
    def _slot(row: Any) -> dict[str, Any]:
        return {
            "slot_id": row["id"],
            "technician": row["technician"],
            "starts_at": row["starts_at"],
            "ends_at": row["ends_at"],
            "visit_type": row["visit_type"],
            "status": row["status"],
            "booked_request_id": row["booked_request_id"],
            "note": row["note"],
        }

    @staticmethod
    def _request(row: Any) -> dict[str, Any]:
        return {
            "request_id": row["id"],
            "status": row["status"],
            "device": loads(row["device"]),
            "issue": row["issue"],
            "slot_id": row["slot_id"],
            "estimate_cents": row["estimate_cents"],
            "reference": row["reference"],
            "created_at": row["created_at"],
            "confirmed_at": row["confirmed_at"],
        }
