"""The companion's state and rules, kept on the coordinator (the Mac, or a Raspberry Pi).

Rules that matter:

- **Nothing without pairing.** A phone gets a device token only by typing (or scanning) a six-digit code shown on the
  person's screen. A code lasts 5 minutes, works once, and is burned after 5 wrong tries.
- **Carers suggest, the person decides.** A change that makes the person less safe, or that would make AGENCY text or
  call a real phone number, waits until the person allows it on their screen. Everything else applies at once, and
  every change is logged with who made it.
- **Everything shows on the Mac.** Contacts and safety settings live here and change at once; details, phrases,
  favourite sites and the Papers folder live on the Mac, which picks them up, applies them and reports back.
- **The person's details don't linger.** Once a details change is applied (or turned down) its copy here is erased.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError

from ..db import Database, dumps, loads
from ..lifeline.models import Contact
from ..lifeline.service import LifelineService, iso, parse
from .models import (
    ContactsChange,
    DetailsChange,
    FavouritesChange,
    PapersFolderChange,
    PhrasesChange,
    Presence,
    SafetyChange,
)
from .security import hash_secret, new_code, new_token, same

ENABLED_KEY = "companion_enabled"
PRESENCE_KEY = "companion_presence"
SNAPSHOT_KEY = "companion_snapshot"

CODE_TTL_S = 300
CODE_TRIES = 5
MAX_DEVICES = 8
RUNNING_WITHIN_S = 30  # the screen sends a Lifeline heartbeat every 5 s
MESSAGES_KEPT_WITH_PHOTOS = 20

# Change statuses. "waiting_person": the person must allow it on their screen. "waiting_mac": the Mac applies it.
APPLIED, WAITING_PERSON, WAITING_MAC, DECLINED, FAILED, REPLACED = (
    "applied",
    "waiting_person",
    "waiting_mac",
    "declined",
    "failed",
    "replaced",
)
OPEN_STATUSES = (WAITING_PERSON, WAITING_MAC)
ON_THE_MAC = {"details", "phrases", "favourites", "papers_folder"}
MODELS: dict[str, type[Any]] = {
    "contacts": ContactsChange,
    "details": DetailsChange,
    "phrases": PhrasesChange,
    "favourites": FavouritesChange,
    "papers_folder": PapersFolderChange,
    "safety": SafetyChange,
}
FOLDERS = {"papers": "the AGENCY Papers folder in Documents", "downloads": "the Downloads folder"}


class CompanionError(Exception):
    """Something the caller asked for isn't allowed now. The message is shown as is."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


def plain_error(exc: ValidationError) -> str:
    """The first validation problem in plain words (our validators already write them that way)."""
    first = exc.errors()[0] if exc.errors() else {"msg": "That wasn't understood."}
    msg = str(first.get("msg", "That wasn't understood."))
    return msg.removeprefix("Value error, ")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


class CompanionService:
    def __init__(self, db: Database, lifeline: LifelineService) -> None:
        self.db = db
        self.lifeline = lifeline
        self.now: Callable[[], datetime] = lambda: datetime.now(UTC)

    # ------------------------------------------------------------------------------
    # on / off
    # ------------------------------------------------------------------------------
    def enabled(self) -> bool:
        return bool((self.db.get_state(ENABLED_KEY) or {}).get("on"))

    def set_enabled(self, on: bool) -> None:
        self.db.set_state(ENABLED_KEY, {"on": on, "at": iso(self.now())})
        if not on:
            # Turning it off ends any pairing in progress and drops the copy of the Mac's setup kept for phones.
            self.db.execute("UPDATE companion_pairing SET used_at = ? WHERE used_at IS NULL", (iso(self.now()),))
            self.db.set_state(SNAPSHOT_KEY, None)
        self._log(None, "At the Mac", "device", f"Caregiver phones turned {'on' if on else 'off'}.")

    # ------------------------------------------------------------------------------
    # pairing and devices
    # ------------------------------------------------------------------------------
    def start_pairing(self) -> dict[str, Any]:
        if not self.enabled():
            raise CompanionError("Turn on caregiver phones first.")
        now = self.now()
        # One code at a time: showing a new one retires the old.
        self.db.execute("UPDATE companion_pairing SET used_at = ? WHERE used_at IS NULL", (iso(now),))
        code = new_code()
        pairing_id = secrets.token_hex(8)
        expires = now + timedelta(seconds=CODE_TTL_S)
        self.db.execute(
            "INSERT INTO companion_pairing(id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (pairing_id, hash_secret(f"{pairing_id}:{code}"), iso(now), iso(expires)),
        )
        return {"code": code, "expires_at": iso(expires), "ttl_s": CODE_TTL_S}

    def cancel_pairing(self) -> None:
        self.db.execute("UPDATE companion_pairing SET used_at = ? WHERE used_at IS NULL", (iso(self.now()),))

    def pairing_open(self) -> dict[str, Any] | None:
        row = self.db.query_one(
            "SELECT * FROM companion_pairing WHERE used_at IS NULL AND expires_at > ? AND attempts < ? "
            "ORDER BY created_at DESC LIMIT 1",
            (iso(self.now()), CODE_TRIES),
        )
        return dict(row) if row else None

    def pair(self, code: str, name: str, contact_id: str | None) -> tuple[dict[str, Any], str]:
        if not self.enabled():
            raise CompanionError("Caregiver phones are turned off on the Mac.", 403)
        pairing = self.pairing_open()
        if not pairing:
            raise CompanionError("There's no pairing code showing on the Mac right now. Ask for a new one.", 403)
        if not same(hash_secret(f"{pairing['id']}:{code}"), pairing["code_hash"]):
            self.db.execute("UPDATE companion_pairing SET attempts = attempts + 1 WHERE id = ?", (pairing["id"],))
            left = CODE_TRIES - pairing["attempts"] - 1
            if left <= 0:
                self._log(None, name, "device", f"A phone typed a wrong pairing code {CODE_TRIES} times. The code was cancelled.")
                raise CompanionError("That code is wrong, and it has now been cancelled. Show a new code on the Mac.", 403)
            raise CompanionError(f"That code is wrong. {_plural(left, 'try')} left.", 403)
        active = self.db.query("SELECT id FROM companion_devices WHERE revoked_at IS NULL")
        if len(active) >= MAX_DEVICES:
            raise CompanionError(f"{MAX_DEVICES} phones are already paired. Remove one on the Mac first.")
        if contact_id and not self._contact(contact_id):
            contact_id = None
        token = new_token()
        device_id = "dev_" + secrets.token_hex(6)
        now = iso(self.now())
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO companion_devices(id, name, contact_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
                (device_id, name, contact_id, hash_secret(token), now, now),
            )
            self.db.execute(
                "UPDATE companion_pairing SET used_at = ?, device_id = ? WHERE id = ?", (now, device_id, pairing["id"])
            )
        self._log(device_id, name, "device", f"{name}'s phone was paired.")
        return self.device(device_id), token

    def authenticate(self, token: str | None) -> dict[str, Any] | None:
        if not token or len(token) > 100 or not self.enabled():
            return None
        row = self.db.query_one("SELECT * FROM companion_devices WHERE token_hash = ?", (hash_secret(token),))
        if not row or row["revoked_at"]:
            return None
        device = dict(row)
        now = self.now()
        seen = parse(device["last_seen_at"])
        if not seen or (now - seen).total_seconds() > 20:
            self.db.execute("UPDATE companion_devices SET last_seen_at = ? WHERE id = ?", (iso(now), device["id"]))
            device["last_seen_at"] = iso(now)
        return device

    def device(self, device_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM companion_devices WHERE id = ?", (device_id,))
        if not row:
            raise CompanionError("That phone isn't paired.", 404)
        return self._device_view(dict(row))

    def _device_view(self, row: dict[str, Any]) -> dict[str, Any]:
        contact = self._contact(row["contact_id"]) if row["contact_id"] else None
        return {
            "id": row["id"],
            "name": row["name"],
            "contact_id": row["contact_id"],
            "contact_name": contact.name if contact else None,
            "created_at": row["created_at"],
            "last_seen_at": row["last_seen_at"],
            "revoked_at": row["revoked_at"],
        }

    def devices(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM companion_devices WHERE revoked_at IS NULL ORDER BY created_at")
        return [self._device_view(dict(r)) for r in rows]

    def revoke(self, device_id: str) -> dict[str, Any]:
        device = self.device(device_id)
        if device["revoked_at"]:
            return device
        self.db.execute("UPDATE companion_devices SET revoked_at = ? WHERE id = ?", (iso(self.now()), device_id))
        self._log(None, "At the Mac", "device", f"{device['name']}'s phone was removed. It can't see or change anything now.")
        return self.device(device_id)

    def link(self, device: dict[str, Any], contact_id: str | None) -> dict[str, Any]:
        if contact_id and not self._contact(contact_id):
            raise CompanionError("That person isn't on the Lifeline list.", 404)
        self.db.execute("UPDATE companion_devices SET contact_id = ? WHERE id = ?", (contact_id, device["id"]))
        return self.device(device["id"])

    def _contact(self, contact_id: str | None) -> Contact | None:
        return next((c for c in self.lifeline.settings().contacts if c.id == contact_id), None)

    # ------------------------------------------------------------------------------
    # what the person's screen says about itself
    # ------------------------------------------------------------------------------
    def set_presence(self, presence: Presence) -> None:
        self.db.set_state(PRESENCE_KEY, presence.model_dump() | {"at": iso(self.now())})

    def set_snapshot(self, snapshot: dict[str, Any]) -> None:
        """What the Mac keeps (phrases, favourite sites, Papers folder, details), so a phone can show and edit it."""
        if self.enabled():
            self.db.set_state(SNAPSHOT_KEY, snapshot | {"at": iso(self.now())})

    def snapshot(self) -> dict[str, Any]:
        snap: dict[str, Any] = self.db.get_state(SNAPSHOT_KEY) or {}
        return snap

    # ------------------------------------------------------------------------------
    # changes from phones
    # ------------------------------------------------------------------------------
    async def submit(self, device: dict[str, Any], kind: str, body: dict[str, Any]) -> dict[str, Any]:
        model = MODELS.get(kind)
        if model is None:
            raise CompanionError("AGENCY can't change that from a phone.", 404)
        try:
            change = model.model_validate(body)
        except ValidationError as exc:
            raise CompanionError(plain_error(exc), 422) from exc
        payload = change.model_dump()
        author = device["name"]
        if kind == "contacts":
            summary, needs_person = self._contacts_summary(change.contacts)
        elif kind == "safety":
            summary, needs_person = self._safety_summary(change)
        else:
            summary, needs_person = self._mac_summary(kind, change), False
        if not summary:
            return {"status": "unchanged", "summary": "Nothing changed."}
        # A newer change of the same kind replaces one that hasn't been applied yet.
        self.db.execute(
            "UPDATE companion_changes SET status = ?, settled_at = ?, payload = '{}' WHERE kind = ? AND status IN (?, ?)",
            (REPLACED, iso(self.now()), kind, *OPEN_STATUSES),
        )
        if needs_person:
            status = WAITING_PERSON
        elif kind in ON_THE_MAC:
            status = WAITING_MAC
        else:
            status = APPLIED
        change_id = self._log(device["id"], author, kind, summary, payload=payload, status=status)
        if status == APPLIED:
            await self._apply_here(kind, payload)
        return self.change(change_id)

    def _contacts_summary(self, contacts: list[Contact]) -> tuple[str, bool]:
        old = {c.id: c for c in self.lifeline.settings().contacts}
        new = {c.id: c for c in contacts}
        parts: list[str] = []
        weaker = False
        for c in contacts:
            before = old.get(c.id)
            real = c.channel != "demo"
            if before is None:
                parts.append(f"added {c.name}" + (" (real texts)" if real else ""))
                weaker |= real
            elif before != c:
                parts.append(f"changed {c.name}")
                if real and (before.channel != c.channel or before.address != c.address):
                    weaker = True  # a new real number to text or call
                if before.enabled and not c.enabled:
                    weaker = True
        for cid, c in old.items():
            if cid not in new:
                parts.append(f"removed {c.name}")
                weaker = True
        order_before = [c.id for c in sorted(old.values(), key=lambda c: (c.priority, c.name))]
        order_after = [c.id for c in sorted(contacts, key=lambda c: (c.priority, c.name))]
        if not parts and order_before != order_after:
            parts.append("changed the order")
        return ("Lifeline contacts: " + ", ".join(parts) + ".") if parts else "", weaker

    def _safety_summary(self, s: SafetyChange) -> tuple[str, bool]:
        cur = self.lifeline.settings()
        armed = bool(self.lifeline.monitor().get("armed"))
        parts: list[str] = []
        weaker = False
        if s.watch != armed:
            parts.append(f"Watch over me {'on' if s.watch else 'off'}")
            weaker |= not s.watch
        if s.checkin_interval_min != cur.checkin_interval_min:
            parts.append(f"check-ins every {s.checkin_interval_min} minutes" if s.checkin_interval_min else "check-ins off")
            was = cur.checkin_interval_min
            weaker |= s.checkin_interval_min == 0 or (was > 0 and s.checkin_interval_min > was)
        if s.alert_on_signal_unavailable != cur.alert_on_signal_unavailable:
            parts.append(f"alert when the eyes can't be seen {'on' if s.alert_on_signal_unavailable else 'off'}")
            weaker |= not s.alert_on_signal_unavailable
        if s.ack_timeout_s != cur.ack_timeout_s:
            parts.append(f"wait {s.ack_timeout_s} s for each person to answer")
            weaker |= s.ack_timeout_s > cur.ack_timeout_s
        if s.watchdog_timeout_s != cur.watchdog_timeout_s:
            parts.append(f"alert after {s.watchdog_timeout_s} s of silence")
            weaker |= s.watchdog_timeout_s > cur.watchdog_timeout_s
        return ("Safety: " + ", ".join(parts) + ".") if parts else "", weaker

    def _mac_summary(self, kind: str, change: Any) -> str:
        snap = self.snapshot()
        if kind == "phrases":
            before = set(snap.get("phrases") or [])
            after = set(change.phrases)
            added, removed = len(after - before), len(before - after)
            if not snap.get("phrases") and not after:
                return ""
            if not added and not removed and snap.get("phrases") is not None:
                return ""
            bits = [
                f"added {_plural(added, 'phrase')}" if added else "",
                f"removed {_plural(removed, 'phrase')}" if removed else "",
            ]
            return "Talk phrases: " + " and ".join(b for b in bits if b) + "." if added or removed else "Talk phrases updated."
        if kind == "favourites":
            names = ", ".join(f.title for f in change.favourites[:4]) + ("…" if len(change.favourites) > 4 else "")
            return f"Favourite sites: {names or 'none'}."
        if kind == "papers_folder":
            return f"Papers folder: {FOLDERS[change.folder]}."
        d = change.details
        filled = [k for k, v in d.model_dump().items() if v]
        return f"Details for forms: {len(filled)} {'box' if len(filled) == 1 else 'boxes'} filled in."

    async def _apply_here(self, kind: str, payload: dict[str, Any]) -> None:
        """Contacts and safety settings live on the coordinator: change them now."""
        if kind == "contacts":
            async with self.lifeline.lock:
                current = self.lifeline.settings()
                contacts = [Contact.model_validate(c) for c in payload["contacts"]]
                self.lifeline.save_settings(current.model_copy(update={"contacts": contacts}))
        elif kind == "safety":
            async with self.lifeline.lock:
                current = self.lifeline.settings()
                self.lifeline.save_settings(
                    current.model_copy(
                        update={
                            "checkin_interval_min": payload["checkin_interval_min"],
                            "alert_on_signal_unavailable": payload["alert_on_signal_unavailable"],
                            "ack_timeout_s": payload["ack_timeout_s"],
                            "watchdog_timeout_s": payload["watchdog_timeout_s"],
                        }
                    )
                )
            if bool(self.lifeline.monitor().get("armed")) != payload["watch"]:
                await self.lifeline.set_armed(payload["watch"])

    async def decide(self, change_id: int, allow: bool) -> dict[str, Any]:
        """The person allows or turns down a change that waited for them."""
        change = self.change(change_id)
        if change["status"] != WAITING_PERSON:
            raise CompanionError("That change isn't waiting for an answer any more.")
        now = iso(self.now())
        if not allow:
            self.db.execute(
                "UPDATE companion_changes SET status = ?, settled_at = ?, payload = '{}', reason = ? WHERE id = ?",
                (DECLINED, now, "Turned down at the Mac.", change_id),
            )
            return self.change(change_id)
        payload = self._payload(change_id)
        if change["kind"] in ON_THE_MAC:
            self.db.execute("UPDATE companion_changes SET status = ? WHERE id = ?", (WAITING_MAC, change_id))
        else:
            # Re-check against today's settings: if they moved meanwhile, the model still validates it.
            MODELS[change["kind"]].model_validate(payload)
            await self._apply_here(change["kind"], payload)
            self.db.execute(
                "UPDATE companion_changes SET status = ?, settled_at = ?, reason = ? WHERE id = ?",
                (APPLIED, now, "Allowed at the Mac.", change_id),
            )
        return self.change(change_id)

    def applied_on_mac(self, change_id: int, ok: bool, reason: str) -> dict[str, Any]:
        change = self.change(change_id)
        if change["status"] != WAITING_MAC:
            return change
        self.db.execute(
            "UPDATE companion_changes SET status = ?, settled_at = ?, reason = ?, payload = CASE WHEN kind = 'details' "
            "THEN '{}' ELSE payload END WHERE id = ?",
            (APPLIED if ok else FAILED, iso(self.now()), reason[:200] or None, change_id),
        )
        return self.change(change_id)

    def _payload(self, change_id: int) -> dict[str, Any]:
        row = self.db.query_one("SELECT payload FROM companion_changes WHERE id = ?", (change_id,))
        data: dict[str, Any] = loads(row["payload"]) if row else {}
        return data

    def change(self, change_id: int) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM companion_changes WHERE id = ?", (change_id,))
        if not row:
            raise CompanionError("That change wasn't found.", 404)
        return self._change_view(dict(row))

    @staticmethod
    def _change_view(row: dict[str, Any], *, with_payload: bool = False) -> dict[str, Any]:
        out = {
            k: row[k] for k in ("id", "device_id", "author", "kind", "summary", "status", "reason", "created_at", "settled_at")
        }
        if with_payload:
            out["payload"] = loads(row["payload"])
        return out

    def changes(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM companion_changes ORDER BY id DESC LIMIT ?", (max(1, min(limit, 200)),))
        return [self._change_view(dict(r)) for r in rows]

    def open_changes(self) -> list[dict[str, Any]]:
        """For the Mac: changes it must apply (with their content) and ones waiting for the person."""
        rows = self.db.query("SELECT * FROM companion_changes WHERE status IN (?, ?) ORDER BY id", OPEN_STATUSES)
        return [self._change_view(dict(r), with_payload=r["status"] == WAITING_MAC) for r in rows]

    def _log(
        self,
        device_id: str | None,
        author: str,
        kind: str,
        summary: str,
        *,
        payload: dict[str, Any] | None = None,
        status: str = APPLIED,
    ) -> int:
        now = iso(self.now())
        cur = self.db.execute(
            "INSERT INTO companion_changes(device_id, author, kind, summary, payload, status, created_at, settled_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (device_id, author, kind, summary, dumps(payload or {}), status, now, now if status == APPLIED else None),
        )
        return int(cur.lastrowid or 0)

    # ------------------------------------------------------------------------------
    # hand-over notes
    # ------------------------------------------------------------------------------
    def add_note(self, author: str, text: str, device_id: str | None = None) -> dict[str, Any]:
        cur = self.db.execute(
            "INSERT INTO companion_notes(device_id, author, text, created_at) VALUES (?, ?, ?, ?)",
            (device_id, author, text, iso(self.now())),
        )
        row = self.db.query_one("SELECT * FROM companion_notes WHERE id = ?", (cur.lastrowid,))
        assert row is not None
        return dict(row)

    def notes(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM companion_notes ORDER BY id DESC LIMIT ?", (max(1, min(limit, 200)),))
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------------------
    # messages and photos for the person's screen
    # ------------------------------------------------------------------------------
    def send_message(self, device: dict[str, Any], text: str, photo: str | None) -> dict[str, Any]:
        if not text and not photo:
            raise CompanionError("Write a few words or add a photo.", 422)
        cur = self.db.execute(
            "INSERT INTO companion_messages(device_id, author, text, photo, created_at) VALUES (?, ?, ?, ?, ?)",
            (device["id"], device["name"], text, photo, iso(self.now())),
        )
        # Photos are only kept for the most recent messages, so the database doesn't fill up with pictures.
        self.db.execute(
            "UPDATE companion_messages SET photo = NULL WHERE photo IS NOT NULL AND id NOT IN "
            "(SELECT id FROM companion_messages ORDER BY id DESC LIMIT ?)",
            (MESSAGES_KEPT_WITH_PHOTOS,),
        )
        return self.message(int(cur.lastrowid or 0))

    def message(self, message_id: int, *, with_photo: bool = False) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM companion_messages WHERE id = ?", (message_id,))
        if not row:
            raise CompanionError("That message wasn't found.", 404)
        return self._message_view(dict(row), with_photo=with_photo)

    @staticmethod
    def _message_view(row: dict[str, Any], *, with_photo: bool) -> dict[str, Any]:
        out = {k: row[k] for k in ("id", "device_id", "author", "text", "created_at", "seen_at")}
        out["has_photo"] = bool(row["photo"])
        if with_photo:
            out["photo"] = row["photo"]
        return out

    def inbox(self) -> list[dict[str, Any]]:
        """Unseen messages for the person's screen, oldest first, only from phones still paired."""
        rows = self.db.query(
            "SELECT m.* FROM companion_messages m JOIN companion_devices d ON d.id = m.device_id "
            "WHERE m.seen_at IS NULL AND d.revoked_at IS NULL ORDER BY m.id LIMIT 5"
        )
        return [self._message_view(dict(r), with_photo=True) for r in rows]

    def mark_seen(self, message_id: int) -> dict[str, Any]:
        self.message(message_id)
        self.db.execute(
            "UPDATE companion_messages SET seen_at = ? WHERE id = ? AND seen_at IS NULL", (iso(self.now()), message_id)
        )
        return self.message(message_id)

    def sent_by(self, device_id: str, limit: int = 10) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM companion_messages WHERE device_id = ? ORDER BY id DESC LIMIT ?", (device_id, limit))
        return [self._message_view(dict(r), with_photo=False) for r in rows]

    # ------------------------------------------------------------------------------
    # what a phone sees on its first screen
    # ------------------------------------------------------------------------------
    def home(self, device: dict[str, Any]) -> dict[str, Any]:
        now = self.now()
        status = self.lifeline.status()
        monitor = status["monitor"]
        beat = monitor.get("last_heartbeat") or {}
        last = parse(monitor.get("last_heartbeat_at"))
        running = bool(last and (now - last).total_seconds() <= RUNNING_WITHIN_S)
        presence = self.db.get_state(PRESENCE_KEY) or {}
        presence_at = parse(presence.get("at"))
        battery_fresh = bool(presence_at and (now - presence_at).total_seconds() <= 180)
        level = presence.get("battery_level") if battery_fresh else None
        charging = presence.get("charging") if battery_fresh else None
        camera = beat.get("camera") if running else None
        open_alert = status["open_alert"]
        alert = None
        if open_alert:
            alert = {
                "id": open_alert["id"],
                "status": open_alert["status"],
                "is_test": open_alert["is_test"],
                "what": open_alert["what"],
                "situation_label": open_alert.get("situation_label"),
                "urgency": open_alert.get("urgency"),
                "acknowledged_by": open_alert.get("acknowledged_by"),
                "respond_path": self._respond_path(open_alert["id"], device.get("contact_id")),
                "contacted": [
                    {"name": n.get("contact_name") or n["contact_id"], "status": n["status"], "response": n.get("response")}
                    for n in open_alert.get("notifications", [])
                    if n["purpose"] == "alert"
                ][-8:],
            }
        settings = status["settings"]
        return {
            "server_time": iso(now),
            "device": self.device(device["id"]),
            "person": settings["responder"]["person_name"] or "The person",
            "running": running,
            "last_heard_at": monitor.get("last_heartbeat_at"),
            "camera": {
                "state": camera,
                "ok": bool(running and camera == "on" and beat.get("face_visible")),
                "face_visible": bool(beat.get("face_visible")) if running else None,
                "eye_signal": bool(beat.get("signal_ready")) if running else None,
            },
            "battery": {"level": level, "charging": charging, "known": level is not None},
            "watch": {
                "armed": monitor["armed"],
                "next_checkin_at": monitor.get("next_checkin_at"),
                "checkin_pending_since": monitor.get("checkin_pending_since"),
                "checkin_last_ok_at": monitor.get("checkin_last_ok_at"),
            },
            "alert": alert,
            "recent_alerts": [
                {
                    "id": a["id"],
                    "what": a["what"],
                    "status": a["status"],
                    "is_test": a["is_test"],
                    "created_at": a["created_at"],
                    "acknowledged_by": a.get("acknowledged_by"),
                    "resolved_by": a.get("resolved_by"),
                }
                for a in status["recent"][:5]
            ],
            "waiting_for_person": len(self.db.query("SELECT id FROM companion_changes WHERE status = ?", (WAITING_PERSON,))),
            "lifeline_problems": status["problems"],
        }

    def _respond_path(self, alert_id: str, contact_id: str | None) -> str | None:
        """This phone's own response page for the open alert, if its person has been asked to help."""
        if not contact_id:
            return None
        row = self.db.query_one(
            "SELECT token FROM lifeline_notifications WHERE alert_id = ? AND contact_id = ? AND purpose = 'alert' "
            "AND token IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (alert_id, contact_id),
        )
        return f"/respond/{row['token']}" if row else None

    def setup(self) -> dict[str, Any]:
        """Everything a phone can change, as it is now."""
        s = self.lifeline.settings()
        snap = self.snapshot()
        return {
            "contacts": [c.model_dump() for c in s.contacts],
            "safety": {
                "watch": bool(self.lifeline.monitor().get("armed")),
                "checkin_interval_min": s.checkin_interval_min,
                "alert_on_signal_unavailable": s.alert_on_signal_unavailable,
                "ack_timeout_s": s.ack_timeout_s,
                "watchdog_timeout_s": s.watchdog_timeout_s,
            },
            "mac": {
                "known": bool(snap),
                "at": snap.get("at"),
                "phrases": snap.get("phrases") or [],
                "favourites": snap.get("favourites") or [],
                "papers_folder": snap.get("papers_folder"),
                "details": snap.get("details"),
            },
            "open": [
                self._change_view(dict(r))
                for r in self.db.query("SELECT * FROM companion_changes WHERE status IN (?, ?) ORDER BY id", OPEN_STATUSES)
            ],
        }
