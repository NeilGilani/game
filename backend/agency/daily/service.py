"""The day's schedule, care routines and non-urgent requests to a carer.

Rules:

* The schedule and routines are only shown on the person's screen. Nothing here is a clinical alarm or
  medication advice, and nothing escalates.
* A request reaches a carer only when ``carer_notify`` is on and a carer is chosen. It goes to that one
  person, once, through Lifeline's channels: a simulated phone for practice contacts, a real text message
  only for a contact with a real number on a coordinator with Twilio. Never a phone call.
* Requests are rate limited, and an identical request within a minute is not sent twice.
* The carer's reply link opens only that one request, shows only the words of the request, and stops
  accepting replies after a few hours.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from ..db import Database
from ..lifeline.channels import ChannelRouter, Delivery, Outgoing
from ..lifeline.models import Contact, LifelineSettings
from .models import (
    DailySettings,
    MarkBody,
    RequestBody,
    Routine,
    ScheduleItem,
)

log = logging.getLogger("agency.daily")

SETTINGS_KEY = "daily_settings"
ITEMS_KEY = "daily_items"
ROUTINES_KEY = "daily_routines"
ROUTINE_STATE_KEY = "daily_routine_state"
MARKS_KEY = "daily_marks"

KEEP_MARK_DAYS = 14
KEEP_REQUESTS = 200
REPLY_HOURS = 6
DUPLICATE_S = 60
# Requests that reach a phone: at most this many in this many minutes.
LIMIT_COUNT = 6
LIMIT_MINUTES = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_requests (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    carer_id TEXT,
    carer_name TEXT,
    channel TEXT,
    status TEXT NOT NULL,
    simulated INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    body TEXT,
    token TEXT,
    reply TEXT,
    replied_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_requests_token ON daily_requests(token);
CREATE INDEX IF NOT EXISTS idx_daily_requests_created ON daily_requests(created_at)
"""

REPLY_WORDS = {
    "coming": "On my way",
    "soon": "In a few minutes",
    "cant": "Can't come right now",
}


class DailyError(RuntimeError):
    """A request the daily service refuses, shown to the person as-is."""


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class DailyService:
    def __init__(
        self,
        db: Database,
        channels: ChannelRouter,
        lifeline_settings: Callable[[], LifelineSettings],
        *,
        public_url: str,
    ) -> None:
        self.db = db
        self.channels = channels
        self.lifeline_settings = lifeline_settings
        self.public_url = public_url.rstrip("/")
        self.now: Callable[[], datetime] = lambda: datetime.now(UTC)
        self.lock = asyncio.Lock()
        for statement in SCHEMA.split(";"):
            if statement.strip():
                self.db.execute(statement)

    # ------------------------------------------------------------------------------
    # settings, schedule and routines
    # ------------------------------------------------------------------------------
    def settings(self) -> DailySettings:
        raw = self.db.get_state(SETTINGS_KEY)
        try:
            return DailySettings.model_validate(raw) if raw else DailySettings()
        except ValueError:
            return DailySettings()

    def save_settings(self, new: DailySettings) -> DailySettings:
        if new.carer_id and not any(c.id == new.carer_id for c in self.lifeline_settings().contacts):
            raise DailyError("That carer isn't one of the saved Lifeline contacts.")
        self.db.set_state(SETTINGS_KEY, new.model_dump())
        log.info("carer requests %s", "on" if new.carer_notify else "off")
        return new

    def items(self) -> list[ScheduleItem]:
        raw = self.db.get_state(ITEMS_KEY) or []
        return [ScheduleItem.model_validate(i) for i in raw]

    def save_items(self, items: list[ScheduleItem]) -> list[ScheduleItem]:
        self.db.set_state(ITEMS_KEY, [i.model_dump() for i in items])
        return items

    def routines(self) -> list[Routine]:
        raw = self.db.get_state(ROUTINES_KEY) or []
        return [Routine.model_validate(r) for r in raw]

    def save_routines(self, routines: list[Routine]) -> list[Routine]:
        self.db.set_state(ROUTINES_KEY, [r.model_dump() for r in routines])
        ids = {r.id for r in routines}
        state = {k: v for k, v in self._routine_state().items() if k in ids}
        self.db.set_state(ROUTINE_STATE_KEY, state)
        return routines

    def _routine_state(self) -> dict[str, dict[str, str | None]]:
        raw = self.db.get_state(ROUTINE_STATE_KEY) or {}
        return raw if isinstance(raw, dict) else {}

    def routine_done(self, routine_id: str) -> dict[str, Any]:
        self._routine(routine_id)
        with self.db.transaction():
            state = self._routine_state()
            state[routine_id] = {"last_done_at": iso(self.now()), "snoozed_until": None}
            self.db.set_state(ROUTINE_STATE_KEY, state)
        return state[routine_id]

    def routine_later(self, routine_id: str, minutes: int) -> dict[str, Any]:
        self._routine(routine_id)
        with self.db.transaction():
            state = self._routine_state()
            current = state.get(routine_id) or {"last_done_at": None}
            state[routine_id] = {
                "last_done_at": current.get("last_done_at"),
                "snoozed_until": iso(self.now() + timedelta(minutes=minutes)),
            }
            self.db.set_state(ROUTINE_STATE_KEY, state)
        return state[routine_id]

    def _routine(self, routine_id: str) -> Routine:
        for r in self.routines():
            if r.id == routine_id:
                return r
        raise DailyError("That routine isn't set up any more.")

    def _marks(self) -> dict[str, dict[str, dict[str, str | None]]]:
        raw = self.db.get_state(MARKS_KEY) or {}
        return raw if isinstance(raw, dict) else {}

    def mark(self, body: MarkBody) -> dict[str, dict[str, str | None]]:
        if not any(i.id == body.item_id for i in self.items()):
            raise DailyError("That isn't in the schedule any more.")
        if body.status == "later" and not body.until:
            raise DailyError("Later needs a time to show it again.")
        with self.db.transaction():
            marks = self._marks()
            day = marks.setdefault(body.day, {})
            if body.status == "clear":
                day.pop(body.item_id, None)
            else:
                day[body.item_id] = {
                    "status": body.status,
                    "until": body.until if body.status == "later" else None,
                    "at": iso(self.now()),
                }
            # Keep only the last couple of weeks.
            for old in sorted(marks)[:-KEEP_MARK_DAYS]:
                marks.pop(old, None)
            self.db.set_state(MARKS_KEY, marks)
        return marks.get(body.day, {})

    def carers(self) -> list[dict[str, Any]]:
        """The Lifeline contacts a request could go to, and how each would get it."""
        return [
            {
                "id": c.id,
                "name": c.name,
                "role": c.role,
                "channel": c.channel,
                "simulated": c.channel == "demo",
                "reachable": c.channel == "demo" or self.channels.twilio_configured,
            }
            for c in self.lifeline_settings().contacts
            if c.enabled
        ]

    def state(self, day: str) -> dict[str, Any]:
        return {
            "settings": self.settings().model_dump(),
            "items": [i.model_dump() for i in self.items()],
            "routines": [r.model_dump() for r in self.routines()],
            "routine_state": self._routine_state(),
            "marks": self._marks().get(day, {}),
            "carers": self.carers(),
            "carer": self._carer_view(),
            "requests": self.requests(10),
        }

    # ------------------------------------------------------------------------------
    # requests to a carer
    # ------------------------------------------------------------------------------
    def _carer(self) -> Contact | None:
        s = self.settings()
        if not s.carer_notify or not s.carer_id:
            return None
        for c in self.lifeline_settings().contacts:
            if c.id == s.carer_id and c.enabled:
                return c
        return None

    def _carer_view(self) -> dict[str, Any] | None:
        """Who a request would reach right now, in words for the confirmation screen. None: nobody (off)."""
        c = self._carer()
        if c is None:
            return None
        if c.channel == "demo":
            how = "a simulated phone (practice: nobody real is contacted)"
        elif self.channels.twilio_configured:
            how = "a real text message"
        else:
            how = "a text message, but real texts aren't set up on this coordinator"
        return {"id": c.id, "name": c.name, "role": c.role, "simulated": c.channel == "demo", "how": how}

    def _person(self) -> str:
        return self.lifeline_settings().responder.person_name or "The person you care for"

    def _compose(self, kind: str, text: str, token: str) -> str:
        link = f"{self.public_url}/carer/{token}"
        lead = {"help": "asks", "routine": "asks", "schedule": "wants you to know"}[kind]
        said = text.rstrip(".!?")
        return f'AGENCY for {self._person()}: they {lead}: "{said}." Not an emergency. Reply here: {link}'

    def _recent_phone_requests(self, since: datetime) -> int:
        row = self.db.query_one(
            "SELECT COUNT(*) AS n FROM daily_requests WHERE created_at >= ? AND carer_id IS NOT NULL", (iso(since),)
        )
        return int(row["n"]) if row else 0

    async def request(self, body: RequestBody) -> dict[str, Any]:
        """Record a request and, when turned on, send it to the chosen carer once."""
        async with self.lock:
            now = self.now()
            dup = self.db.query_one(
                "SELECT * FROM daily_requests WHERE text = ? AND kind = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
                (body.text, body.kind, iso(now - timedelta(seconds=DUPLICATE_S))),
            )
            if dup:
                return {**self._view(dict(dup)), "duplicate": True}
            carer = self._carer()
            rid = f"req_{secrets.token_hex(5)}"
            if carer is None:
                self.db.execute(
                    "INSERT INTO daily_requests(id, kind, text, created_at, status, simulated) VALUES (?,?,?,?,?,?)",
                    (rid, body.kind, body.text, iso(now), "shown", 1),
                )
                self._prune()
                return self._view(self._row(rid))
            if self._recent_phone_requests(now - timedelta(minutes=LIMIT_MINUTES)) >= LIMIT_COUNT:
                raise DailyError(
                    f"{LIMIT_COUNT} requests already went to {carer.name} in the last {LIMIT_MINUTES} minutes. "
                    "So they aren't flooded, wait a little. For anything urgent, use Lifeline."
                )
            token = secrets.token_urlsafe(18)
            text_body = self._compose(body.kind, body.text, token)
            self.db.execute(
                "INSERT INTO daily_requests(id, kind, text, created_at, carer_id, carer_name, channel, status, simulated,"
                " body, token) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    rid,
                    body.kind,
                    body.text,
                    iso(now),
                    carer.id,
                    carer.name,
                    carer.channel,
                    "sending",
                    1 if carer.channel == "demo" else 0,
                    text_body,
                    token,
                ),
            )
            # Purpose "request": Twilio sends a text only (calls are only ever for Lifeline alerts).
            out = Outgoing(contact=carer, body=text_body, voice_text=text_body, purpose="request", primary=False)
            try:
                delivery = await self.channels.send(out)
            except Exception as exc:  # a channel bug must not lose the request
                log.exception("daily request channel crashed")
                delivery = Delivery(status="failed", simulated=False, error=f"Unexpected error: {type(exc).__name__}")
            self.db.execute(
                "UPDATE daily_requests SET status = ?, error = ?, simulated = ? WHERE id = ?",
                (delivery.status, delivery.error, 1 if delivery.simulated else 0, rid),
            )
            log.info("daily request %s to %s: %s", rid, carer.id, delivery.status)
            self._prune()
            return self._view(self._row(rid))

    def _row(self, rid: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM daily_requests WHERE id = ?", (rid,))
        if not row:
            raise DailyError("That request isn't there any more.")
        return dict(row)

    def _prune(self) -> None:
        self.db.execute(
            "DELETE FROM daily_requests WHERE id NOT IN (SELECT id FROM daily_requests ORDER BY created_at DESC LIMIT ?)",
            (KEEP_REQUESTS,),
        )

    def _view(self, r: dict[str, Any]) -> dict[str, Any]:
        """A request as the person's screen sees it (never the token)."""
        return {
            "id": r["id"],
            "kind": r["kind"],
            "text": r["text"],
            "created_at": r["created_at"],
            "status": r["status"],
            "simulated": bool(r["simulated"]),
            "carer": {"id": r["carer_id"], "name": r["carer_name"]} if r["carer_id"] else None,
            "error": r["error"],
            "reply": r["reply"],
            "reply_words": REPLY_WORDS.get(r["reply"] or ""),
            "replied_at": r["replied_at"],
        }

    def requests(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM daily_requests ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,))
        return [self._view(dict(r)) for r in rows]

    def outbox(self) -> list[dict[str, Any]]:
        """Requests to simulated phones, with their working reply links, for the Simulated phones screen."""
        rows = self.db.query(
            "SELECT * FROM daily_requests WHERE channel = 'demo' AND status != 'failed' AND token IS NOT NULL "
            "ORDER BY created_at DESC, rowid DESC LIMIT 30"
        )
        return [
            {
                "id": r["id"],
                "contact_id": r["carer_id"],
                "contact_name": r["carer_name"],
                "body": r["body"],
                "created_at": r["created_at"],
                "reply": r["reply"],
                "link": f"/carer/{r['token']}",
            }
            for r in rows
        ]

    # ------------------------------------------------------------------------------
    # the carer's reply page
    # ------------------------------------------------------------------------------
    def find(self, token: str) -> dict[str, Any] | None:
        if not token or len(token) > 64:
            return None
        row = self.db.query_one("SELECT * FROM daily_requests WHERE token = ?", (token,))
        return dict(row) if row else None

    def expired(self, r: dict[str, Any]) -> bool:
        created = parse(r["created_at"])
        return created is None or self.now() - created > timedelta(hours=REPLY_HOURS)

    def reply(self, token: str, reply: str) -> dict[str, Any] | None:
        r = self.find(token)
        if r is None or reply not in REPLY_WORDS:
            return None
        if self.expired(r):
            raise DailyError("This request is too old to answer.")
        self.db.execute("UPDATE daily_requests SET reply = ?, replied_at = ? WHERE id = ?", (reply, iso(self.now()), r["id"]))
        log.info("daily request %s answered: %s", r["id"], reply)
        return self.find(token)

    def person(self) -> str:
        return self._person()
