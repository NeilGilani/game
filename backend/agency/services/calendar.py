"""Demo Calendar: the user's simulated calendar plus a demo clinic's open times."""

from __future__ import annotations

from typing import Any

from ..db import Database, dumps, loads, utcnow
from .common import Faults, ServiceError, new_id


class DemoCalendar:
    name = "Demo Calendar"
    simulated = True

    def __init__(self, db: Database, faults: Faults) -> None:
        self.db = db
        self.faults = faults

    def list_events(self, *, include_cancelled: bool = False) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM svc_calendar_events ORDER BY starts_at")
        events = [self._event(r) for r in rows]
        return events if include_cancelled else [e for e in events if e["status"] != "cancelled"]

    def get_event(self, event_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_calendar_events WHERE id = ?", (event_id,))
        return self._event(row) if row else None

    def find_by_key(self, idempotency_key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_calendar_events WHERE idempotency_key = ?", (idempotency_key,))
        if row:
            return self._event(row)
        op = self.db.query_one("SELECT * FROM svc_calendar_ops WHERE idempotency_key = ?", (idempotency_key,))
        return self.get_event(op["event_id"]) if op else None

    def list_openings(self, *, provider: str | None = None, before: str | None = None) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM svc_calendar_openings WHERE status = 'open' ORDER BY starts_at")
        openings = [
            {
                "opening_id": r["id"],
                "provider": r["provider"],
                "starts_at": r["starts_at"],
                "ends_at": r["ends_at"],
            }
            for r in rows
        ]
        if provider:
            openings = [o for o in openings if o["provider"] == provider]
        if before:
            openings = [o for o in openings if o["starts_at"][:10] < before]
        return openings

    def create_event(
        self,
        *,
        idempotency_key: str,
        title: str,
        starts_at: str,
        ends_at: str,
        location: str,
        kind: str,
        notes: str,
    ) -> tuple[dict[str, Any], bool]:
        existing = self.find_by_key(idempotency_key)
        if existing:
            return existing, True
        if ends_at <= starts_at:
            raise ServiceError("invalid_time", "An event must end after it starts.")
        event_id = new_id("ev")
        self.db.execute(
            "INSERT INTO svc_calendar_events(id, idempotency_key, title, starts_at, ends_at, location,"
            " kind, status, notes, history, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (event_id, idempotency_key, title, starts_at, ends_at, location, kind, "scheduled", notes, dumps([]), utcnow()),
        )
        created = self.get_event(event_id)
        assert created is not None
        return created, False

    def reschedule(self, *, idempotency_key: str, event_id: str, opening_id: str) -> dict[str, Any]:
        previous = self.find_by_key(idempotency_key)
        if previous:
            return {"event": previous, "replayed": True}
        event = self.get_event(event_id)
        if not event:
            raise ServiceError("unknown_event", f"Event {event_id} not found.", status=404)
        opening = self.db.query_one("SELECT * FROM svc_calendar_openings WHERE id = ?", (opening_id,))
        if not opening or opening["status"] != "open":
            raise ServiceError("opening_unavailable", "That time is no longer available.", status=409)
        history = event["history"] + [{"from": event["starts_at"], "to": opening["starts_at"], "at": utcnow()}]
        with self.db.transaction():
            self.db.execute("UPDATE svc_calendar_openings SET status = 'taken' WHERE id = ?", (opening_id,))
            self.db.execute(
                "UPDATE svc_calendar_events SET starts_at = ?, ends_at = ?, history = ?, status = 'rescheduled' WHERE id = ?",
                (opening["starts_at"], opening["ends_at"], dumps(history), event_id),
            )
            self.db.execute(
                "INSERT INTO svc_calendar_ops(idempotency_key, event_id, created_at) VALUES (?,?,?)",
                (idempotency_key, event_id, utcnow()),
            )
        updated = self.get_event(event_id)
        assert updated is not None
        return {"event": updated, "replayed": False}

    @staticmethod
    def _event(row: Any) -> dict[str, Any]:
        return {
            "event_id": row["id"],
            "title": row["title"],
            "starts_at": row["starts_at"],
            "ends_at": row["ends_at"],
            "location": row["location"],
            "kind": row["kind"],
            "status": row["status"],
            "notes": row["notes"],
            "history": loads(row["history"]),
            "created_at": row["created_at"],
        }
