"""Daily living's "tell my carer": non-urgent requests to one chosen carer.

Separate from Lifeline's emergency path on purpose. A request here:

* is off until the person (or a helper, with them) turns it on;
* goes to one carer, once: no escalation, no repeats, never a phone call, never emergency services;
* goes through Lifeline's existing channels: a simulated phone for practice ("demo") contacts, a real
  text message only for a contact with a real number on a coordinator with Twilio;
* needs the person's approval of exactly what will be sent: ``prepare`` returns the words, who gets
  them and how, with a ticket; ``send`` sends exactly that ticket, once, before it runs out;
* is rate limited, and the same words to the same person within a minute are not sent twice.

The schedule and care routines themselves live on the person's screen (frontend/src/daily). Nothing
here is a clinical alarm or medication advice.
"""

from __future__ import annotations

import logging
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..db import Database, utcnow
from ..lifeline.channels import ChannelRouter, Outgoing
from ..lifeline.models import Contact, LifelineSettings
from .models import DailySettings, PrepareRequest

log = logging.getLogger("agency.daily")

SETTINGS_KEY = "daily_settings"
TICKET_TTL_S = 5 * 60
MAX_PENDING = 8
LIMIT_COUNT = 6
LIMIT_WINDOW_S = 10 * 60
DUPLICATE_S = 60
KEEP_MESSAGES = 200

# Its own table, created here rather than as a numbered migration: several workstreams add migrations
# at once, and this table needs nothing from the others.
SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    channel TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    simulated INTEGER NOT NULL,
    error TEXT
)
"""

CHANNEL_WORDS = {
    "demo": "their practice phone (simulated: nobody is really contacted)",
    "sms": "a text message to their phone",
    "sms_call": "a text message to their phone (never a call for this)",
}


class DailyError(Exception):
    """A request that can't go ahead, in plain words for the person."""


@dataclass
class _Ticket:
    contact: Contact
    kind: str
    text: str
    body: str
    expires: float


def clean_words(text: str) -> str:
    """The person's words on one line: no control characters, single spaces."""
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", text)).strip()


class DailyService:
    def __init__(self, db: Database, channels: Callable[[], ChannelRouter], lifeline: Callable[[], LifelineSettings]) -> None:
        self.db = db
        self._channels = channels
        self._lifeline = lifeline
        self.clock: Callable[[], float] = time.monotonic
        self._tickets: dict[str, _Ticket] = {}
        self._sent: list[tuple[float, str, str]] = []  # (when, contact id, words)
        with db.transaction():
            db.execute(SCHEMA)

    # Settings ----------------------------------------------------------------------------------

    def settings(self) -> DailySettings:
        raw = self.db.get_state(SETTINGS_KEY)
        return DailySettings.model_validate(raw) if raw else DailySettings()

    def save_settings(self, new: DailySettings) -> DailySettings:
        old = self.settings()
        if new.carer_id is not None and self._contact(new.carer_id) is None:
            raise DailyError("That person isn't one of your Lifeline contacts.")
        enabled_at = (old.enabled_at if old.notify_enabled else utcnow()) if new.notify_enabled else None
        saved = new.model_copy(update={"enabled_at": enabled_at})
        self.db.set_state(SETTINGS_KEY, saved.model_dump())
        if not saved.notify_enabled:
            self._tickets.clear()
        log.info("daily: telling a carer %s", "on" if saved.notify_enabled else "off")
        return saved

    def view(self) -> dict[str, Any]:
        """Settings plus who could be told, for the person's and the helper's screens."""
        settings = self.settings()
        carer = self.carer(settings)
        return {
            "settings": settings.model_dump(),
            "carer": self._describe(carer) if carer else None,
            "contacts": [self._describe(c) for c in self._lifeline().enabled_contacts()],
            "twilio_configured": self._channels().twilio_configured,
        }

    def _contact(self, contact_id: str) -> Contact | None:
        return next((c for c in self._lifeline().enabled_contacts() if c.id == contact_id), None)

    def carer(self, settings: DailySettings | None = None) -> Contact | None:
        settings = settings or self.settings()
        if settings.carer_id:
            return self._contact(settings.carer_id)
        contacts = self._lifeline().enabled_contacts()
        return contacts[0] if contacts else None

    def _describe(self, c: Contact) -> dict[str, Any]:
        return {
            "id": c.id,
            "name": c.name,
            "role": c.role,
            "channel": c.channel,
            "simulated": c.channel == "demo",
            "how": CHANNEL_WORDS.get(c.channel, c.channel),
        }

    # Prepare and send ----------------------------------------------------------------------------

    def _body(self, words: str) -> str:
        name = clean_words(self._lifeline().responder.person_name) or "The person you care for"
        return f"{name} (not urgent): {words}\nSent from AGENCY. Nothing else will follow."

    def prepare(self, req: PrepareRequest) -> dict[str, Any]:
        settings = self.settings()
        if not settings.notify_enabled:
            raise DailyError("Telling a carer is off. It can be turned on in Settings, My day and home.")
        words = clean_words(req.text)
        if not words:
            raise DailyError("There's nothing to send.")
        contact = self._contact(req.contact_id) if req.contact_id else self.carer(settings)
        if contact is None:
            raise DailyError("No carer is chosen. Add one in Lifeline setup, then choose them in My day settings.")
        if contact.channel != "demo" and not self._channels().twilio_configured:
            raise DailyError(f"Text messages to {contact.name} aren't set up on this coordinator.")
        now = self.clock()
        self._expire(now)
        if len(self._tickets) >= MAX_PENDING:
            raise DailyError("Too many requests are waiting for your OK. Send or cancel one first.")
        ticket = secrets.token_urlsafe(18)
        body = self._body(words)
        self._tickets[ticket] = _Ticket(contact, req.kind, words, body, now + TICKET_TTL_S)
        return {"ticket": ticket, "to": self._describe(contact), "body": body, "expires_in_s": TICKET_TTL_S}

    def cancel(self, ticket: str) -> None:
        self._tickets.pop(ticket, None)

    def _expire(self, now: float) -> None:
        for key in [k for k, t in self._tickets.items() if t.expires <= now]:
            del self._tickets[key]

    async def send(self, ticket: str) -> dict[str, Any]:
        now = self.clock()
        self._expire(now)
        t = self._tickets.pop(ticket, None)
        if t is None:
            raise DailyError("That request ran out or was already sent. Nothing was sent.")
        if not self.settings().notify_enabled:
            raise DailyError("Telling a carer was turned off. Nothing was sent.")
        if self._contact(t.contact.id) is None:
            raise DailyError(f"{t.contact.name} isn't one of your contacts any more. Nothing was sent.")
        self._sent = [s for s in self._sent if now - s[0] < LIMIT_WINDOW_S]
        if any(cid == t.contact.id and w == t.text and now - when < DUPLICATE_S for when, cid, w in self._sent):
            raise DailyError(f"You sent that to {t.contact.name} less than a minute ago. It wasn't sent twice.")
        if len(self._sent) >= LIMIT_COUNT:
            raise DailyError("That's a lot of requests in a few minutes. Wait a little, then try again.")
        self._sent.append((now, t.contact.id, t.text))
        delivery = await self._channels().send(
            Outgoing(contact=t.contact, body=t.body, voice_text=t.body, purpose="daily", primary=False)
        )
        with self.db.transaction():
            cur = self.db.execute(
                "INSERT INTO daily_messages(created_at, kind, contact_id, contact_name, channel, body, status, simulated, error)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    utcnow(),
                    t.kind,
                    t.contact.id,
                    t.contact.name,
                    t.contact.channel,
                    t.body,
                    delivery.status,
                    int(delivery.simulated),
                    delivery.error,
                ),
            )
            self.db.execute(
                "DELETE FROM daily_messages WHERE id <= (SELECT MAX(id) FROM daily_messages) - ?",
                (KEEP_MESSAGES,),
            )
        log.info("daily: %s request to %s: %s", t.kind, t.contact.id, delivery.status)
        return {
            "id": cur.lastrowid,
            "status": delivery.status,
            "simulated": delivery.simulated,
            "error": delivery.error,
            "to": self._describe(t.contact),
        }

    def messages(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM daily_messages ORDER BY id DESC LIMIT ?", (max(1, min(limit, KEEP_MESSAGES)),))
        return [
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "kind": r["kind"],
                "contact_id": r["contact_id"],
                "contact_name": r["contact_name"],
                "channel": r["channel"],
                "body": r["body"],
                "status": r["status"],
                "simulated": bool(r["simulated"]),
                "error": r["error"],
            }
            for r in rows
        ]
