"""Demo Messaging Service: a simulated outbox. Nothing here reaches a real person."""

from __future__ import annotations

import hashlib
from typing import Any

from ..db import Database, utcnow
from .common import Faults, ServiceError, new_id


def body_digest(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()[:16]


class DemoMessagingService:
    name = "Demo Messaging Service"
    simulated = True

    def __init__(self, db: Database, faults: Faults) -> None:
        self.db = db
        self.faults = faults

    def list_contacts(self) -> list[dict[str, Any]]:
        return [
            {"contact_id": r["id"], "name": r["name"], "role": r["role"], "channel": r["channel"]}
            for r in self.db.query("SELECT * FROM svc_contacts ORDER BY id")
        ]

    def get_contact(self, contact_id: str) -> dict[str, Any] | None:
        for contact in self.list_contacts():
            if contact["contact_id"] == contact_id:
                return contact
        return None

    def get_message(self, message_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_messages WHERE id = ?", (message_id,))
        return self._message(row) if row else None

    def find_draft(self, idempotency_key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_messages WHERE idempotency_key = ?", (idempotency_key,))
        return self._message(row) if row else None

    def find_send(self, idempotency_key: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_message_sends WHERE idempotency_key = ?", (idempotency_key,))
        return self.get_message(row["message_id"]) if row else None

    def list_messages(self) -> list[dict[str, Any]]:
        return [self._message(r) for r in self.db.query("SELECT * FROM svc_messages ORDER BY created_at")]

    def create_draft(self, *, idempotency_key: str, contact_id: str, subject: str, body: str) -> tuple[dict[str, Any], bool]:
        existing = self.find_draft(idempotency_key)
        if existing:
            return existing, True
        if not self.get_contact(contact_id):
            raise ServiceError("unknown_contact", f"Contact {contact_id} not found.", status=404)
        message_id = new_id("msg")
        self.db.execute(
            "INSERT INTO svc_messages(id, idempotency_key, contact_id, subject, body, status, created_at) VALUES (?,?,?,?,?,?,?)",
            (message_id, idempotency_key, contact_id, subject, body, "draft", utcnow()),
        )
        created = self.get_message(message_id)
        assert created is not None
        return created, False

    def update_draft(self, *, message_id: str, body: str) -> dict[str, Any]:
        message = self.get_message(message_id)
        if not message:
            raise ServiceError("unknown_message", f"Message {message_id} not found.", status=404)
        if message["status"] != "draft":
            raise ServiceError("not_a_draft", "Only drafts can be edited.", status=409)
        self.db.execute("UPDATE svc_messages SET body = ? WHERE id = ?", (body, message_id))
        updated = self.get_message(message_id)
        assert updated is not None
        return updated

    def send(self, *, idempotency_key: str, message_id: str) -> dict[str, Any]:
        previous = self.find_send(idempotency_key)
        if previous:
            return {"message": previous, "replayed": True}
        if self.faults.consume_counted("messaging_unavailable"):
            raise ServiceError(
                "service_unavailable",
                "The messaging service is temporarily unavailable.",
                status=503,
                retryable=True,
            )
        message = self.get_message(message_id)
        if not message:
            raise ServiceError("unknown_message", f"Message {message_id} not found.", status=404)
        if message["status"] != "draft":
            raise ServiceError("not_a_draft", "This message was already sent.", status=409)
        with self.db.transaction():
            self.db.execute(
                "UPDATE svc_messages SET status = 'delivered_simulated', sent_at = ? WHERE id = ?",
                (utcnow(), message_id),
            )
            self.db.execute(
                "INSERT INTO svc_message_sends(idempotency_key, message_id, created_at) VALUES (?,?,?)",
                (idempotency_key, message_id, utcnow()),
            )
        sent = self.get_message(message_id)
        assert sent is not None
        return {"message": sent, "replayed": False}

    @staticmethod
    def _message(row: Any) -> dict[str, Any]:
        return {
            "message_id": row["id"],
            "contact_id": row["contact_id"],
            "subject": row["subject"],
            "body": row["body"],
            "body_digest": body_digest(row["body"]),
            "status": row["status"],
            "created_at": row["created_at"],
            "sent_at": row["sent_at"],
        }
