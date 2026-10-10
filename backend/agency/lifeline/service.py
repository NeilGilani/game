"""The Lifeline engine: owns every alert from signal to resolution.

Design rules (see LIFELINE.md for the full safety case):

* The coordinator owns all timers (countdown, escalation, watchdog, check-ins) and stores
  them in SQLite, so an alert keeps escalating even if the person's computer dies or the
  coordinator restarts.
* Help is confirmed only when a person answers "I'm on my way". A message being sent is
  never treated as help arriving.
* Escalation never gives up: when everyone has been tried, everyone is tried again, and the
  local alarm keeps sounding.
* Emergency actions are pre-authorised once, during setup (consent). Nothing asks the person
  for approval in the middle of an emergency.
* Once anyone has been alerted, ending the alert sends everyone an all-clear.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import statistics
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from ..db import Database, dumps, loads
from .channels import ChannelRouter, Outgoing
from .models import Contact, LifelineSettings

log = logging.getLogger("agency.lifeline")

OPEN = ("pending_cancel", "active", "acknowledged")
MONITOR_KEY = "lifeline_monitor"
SETTINGS_KEY = "lifeline_settings"
DEMO_OPERATOR_DELAY_S = 12


class LifelineError(RuntimeError):
    """A request Lifeline refuses, shown to the user as-is."""


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def clock(dt: datetime | None) -> str:
    """Wall-clock time on the coordinator, e.g. '3:02:14 AM'."""
    if dt is None:
        return "an unknown time"
    local = dt.astimezone()
    hour = local.hour % 12 or 12
    return f"{hour}:{local.minute:02d}:{local.second:02d} {'AM' if local.hour < 12 else 'PM'}"


def _names(contacts: list[Contact]) -> str:
    labels = [c.label for c in contacts]
    if len(labels) <= 1:
        return "".join(labels)
    return ", ".join(labels[:-1]) + " and " + labels[-1]


class LifelineService:
    def __init__(self, db: Database, channels: ChannelRouter, *, public_url: str) -> None:
        self.db = db
        self.channels = channels
        self.public_url = public_url.rstrip("/")
        self.lock = asyncio.Lock()
        self.now: Callable[[], datetime] = lambda: datetime.now(UTC)

    # ------------------------------------------------------------------------------
    # settings and monitoring state
    # ------------------------------------------------------------------------------
    def settings(self) -> LifelineSettings:
        raw = self.db.get_state(SETTINGS_KEY)
        return LifelineSettings.model_validate(raw) if raw else LifelineSettings()

    def save_settings(self, new: LifelineSettings) -> LifelineSettings:
        old = self.settings()
        if new.consent and not old.consent:
            new = new.model_copy(update={"consented_at": iso(self.now())})
        elif not new.consent:
            new = new.model_copy(update={"consented_at": None})
        else:
            new = new.model_copy(update={"consented_at": old.consented_at})
        self.db.set_state(SETTINGS_KEY, new.model_dump())
        changes = []
        if new.consent != old.consent:
            changes.append("consent given" if new.consent else "consent withdrawn")
        if [c.model_dump() for c in new.contacts] != [c.model_dump() for c in old.contacts]:
            changes.append(f"{len(new.enabled_contacts())} active contacts")
        self._event(None, "settings", "user", "Lifeline settings updated" + (f": {', '.join(changes)}." if changes else "."))
        if self.monitor().get("armed"):
            self._schedule_checkin(self.now())
        return new

    def monitor(self) -> dict[str, Any]:
        state: dict[str, Any] = self.db.get_state(MONITOR_KEY, {}) or {}
        return state

    def _save_monitor(self, state: dict[str, Any]) -> None:
        self.db.set_state(MONITOR_KEY, state)

    # ------------------------------------------------------------------------------
    # persistence helpers
    # ------------------------------------------------------------------------------
    def _event(self, alert_id: str | None, kind: str, actor: str, message: str, data: dict[str, Any] | None = None) -> None:
        self.db.execute(
            "INSERT INTO lifeline_events(alert_id, ts, kind, actor, message, data) VALUES (?,?,?,?,?,?)",
            (alert_id, iso(self.now()), kind, actor, message, dumps(data or {})),
        )

    def _alert_row(self, alert_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM lifeline_alerts WHERE id = ?", (alert_id,))
        return dict(row) if row else None

    def _update_alert(self, alert_id: str, **fields: Any) -> None:
        fields["updated_at"] = iso(self.now())
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE lifeline_alerts SET {cols} WHERE id = ?", [*fields.values(), alert_id])  # noqa: S608

    def _open_alert(self) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM lifeline_alerts WHERE status IN (?,?,?) ORDER BY created_at DESC LIMIT 1", OPEN)
        return dict(row) if row else None

    def _notifications(self, alert_id: str) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self.db.query(
                "SELECT * FROM lifeline_notifications WHERE alert_id = ? ORDER BY created_at, rowid", (alert_id,)
            )
        ]

    def _person(self) -> str:
        return self.settings().responder.person_name or "The person"

    # ------------------------------------------------------------------------------
    # message text
    # ------------------------------------------------------------------------------
    def _what(self, alert: dict[str, Any]) -> str:
        name = self._person()
        when = clock(parse(alert["created_at"]))
        kind, source = alert["kind"], alert["source"]
        if alert["is_test"]:
            return f"This is a test of {name}'s Lifeline, started at {when}"
        if kind == "watchdog":
            return (
                f"{name}'s AGENCY computer stopped responding at {when} while Watch over me was on, "
                f"so {name} may not be able to call for help"
            )
        if kind == "checkin_missed":
            return f"{name} didn't answer a scheduled check-in at {when}"
        if kind == "signal_unavailable":
            return f"{name}'s eye signal has been unavailable since {when} (camera off or face not visible)"
        how = {
            "eye_signal": "signalled for help with their eyes",
            "help_button": "pressed Help",
            "switch": "used their switch to call for help",
        }.get(source, "called for help")
        return f"{name} {how} at {when}"

    def _compose(
        self, alert: dict[str, Any], purpose: str, token: str | None, context: str = "", extra: str = ""
    ) -> tuple[str, str]:
        name = self._person()
        link = f"{self.public_url}/respond/{token}" if token else ""
        test = bool(alert["is_test"])
        if purpose == "stand_down":
            body = f"{'TEST: ' if test else ''}AGENCY Lifeline: {extra} is on the way to {name}. No action needed unless they ask you."
            return body, body
        if purpose == "all_clear":
            body = f"{'TEST: ' if test else ''}AGENCY Lifeline: all clear. {extra}"
            return body, body
        what = self._what(alert)
        action = "Open the link and press I'm on my way to complete the test." if test else f"Please check on {name} now."
        prefix = "TEST from AGENCY Lifeline (not an emergency): " if test else "AGENCY ALERT: "
        body = f"{prefix}{what}. {context}{action} Respond here: {link}"
        voice = f"This is AGENCY Lifeline. {what}. {context}{action} The link to respond is in your text messages."
        return body, voice

    # ------------------------------------------------------------------------------
    # notifications
    # ------------------------------------------------------------------------------
    async def _notify(
        self,
        alert: dict[str, Any],
        contacts: list[Contact],
        *,
        purpose: str,
        level: int,
        cycle: int,
        context: str = "",
        extra: str = "",
    ) -> list[dict[str, Any]]:
        if not contacts:
            return []
        first_level_ids = {c.id for c in (self.settings().levels() or [[]])[0]}
        rows: list[tuple[str, Contact, Outgoing]] = []
        for contact in contacts:
            token = secrets.token_urlsafe(18) if purpose == "alert" else None
            body, voice = self._compose(alert, purpose, token, context, extra)
            nid = f"ntf_{secrets.token_hex(5)}"
            self.db.execute(
                "INSERT INTO lifeline_notifications(id, alert_id, contact_id, contact_name, contact_role, channel, purpose,"
                " level, cycle, status, body, token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    nid,
                    alert["id"],
                    contact.id,
                    contact.name,
                    contact.role,
                    contact.channel,
                    purpose,
                    level,
                    cycle,
                    "sending",
                    body,
                    token,
                    iso(self.now()),
                ),
            )
            rows.append((nid, contact, Outgoing(contact, body, voice, purpose, contact.id in first_level_ids)))
        deliveries = await asyncio.gather(*(self.channels.send(out) for _, _, out in rows), return_exceptions=True)
        results = []
        for (nid, contact, _out), delivery in zip(rows, deliveries, strict=True):
            error: str | None
            if isinstance(delivery, BaseException):
                log.exception("channel crashed for %s", contact.id, exc_info=delivery)
                status, ref, error, simulated = "failed", None, f"Unexpected error: {type(delivery).__name__}", False
            else:
                status, ref, error, simulated = delivery.status, delivery.provider_ref, delivery.error, delivery.simulated
            self.db.execute(
                "UPDATE lifeline_notifications SET status = ?, provider_ref = ?, error = ?, sent_at = ? WHERE id = ?",
                (status, ref, error, iso(self.now()) if status != "failed" else None, nid),
            )
            if purpose == "alert":
                how = "simulated phone" if simulated else ("text and call" if contact.channel == "sms_call" else "text message")
                if status == "failed":
                    self._event(
                        alert["id"],
                        "delivery_failed",
                        "system",
                        f"Couldn't reach {contact.label}: {error}",
                        {"contact": contact.id},
                    )
                else:
                    self._event(
                        alert["id"],
                        "notified",
                        "system",
                        f"Alert sent to {contact.label} by {how}. Waiting for an answer.",
                        {"contact": contact.id, "channel": contact.channel, "notification": nid},
                    )
            results.append({"id": nid, "contact": contact.id, "status": status})
        return results

    def _sent_contacts(self, alert_id: str, exclude: set[str] | None = None) -> list[Contact]:
        """Contacts who successfully received an alert for this alert (for stand-down / all-clear)."""
        settings = self.settings()
        by_id = {c.id: c for c in settings.contacts}
        seen: list[Contact] = []
        for n in self._notifications(alert_id):
            if n["purpose"] != "alert" or n["status"] == "failed":
                continue
            if exclude and n["contact_id"] in exclude:
                continue
            contact = by_id.get(n["contact_id"])
            if contact and contact not in seen:
                seen.append(contact)
        return seen

    # ------------------------------------------------------------------------------
    # alert lifecycle
    # ------------------------------------------------------------------------------
    async def trigger(self, kind: str, source: str, *, is_test: bool = False) -> tuple[dict[str, Any], bool]:
        """Start an alert. Returns (alert, created). Never creates a second open alert."""
        async with self.lock:
            return await self._create(kind, source, is_test=is_test)

    async def _create(self, kind: str, source: str, *, is_test: bool = False) -> tuple[dict[str, Any], bool]:
        existing = self._open_alert()
        if existing:
            self._event(
                existing["id"],
                "signal_repeated",
                "user" if kind == "help" else "system",
                "Another help signal arrived while this alert is open. It's still being handled.",
                {"source": source},
            )
            return self.alert_detail(existing["id"]), False
        settings = self.settings()
        now = self.now()
        window = settings.cancel_window_s if (kind == "help" and not is_test) else 0
        alert_id = f"alert_{secrets.token_hex(4)}"
        message = {
            "help": "Help requested",
            "watchdog": "Computer stopped responding while Watch over me was on",
            "checkin_missed": "Scheduled check-in not answered",
            "signal_unavailable": "Eye signal unavailable while Watch over me was on",
        }[kind]
        self.db.execute(
            "INSERT INTO lifeline_alerts(id, kind, source, is_test, status, message, created_at, activates_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (
                alert_id,
                kind,
                source,
                1 if is_test else 0,
                "pending_cancel",
                message,
                iso(now),
                iso(now + timedelta(seconds=window)),
                iso(now),
            ),
        )
        alert = self._alert_row(alert_id)
        assert alert is not None
        actor = "user" if kind == "help" else "system"
        self._event(
            alert_id,
            "signal",
            actor,
            f"{self._what(alert)}." + (f" Starting in {window} s unless cancelled." if window else ""),
            {"kind": kind, "source": source, "test": is_test},
        )
        if window == 0:
            await self._activate(alert, now)
        return self.alert_detail(alert_id), True

    async def _activate(self, alert: dict[str, Any], now: datetime) -> None:
        settings = self.settings()
        levels = settings.levels()
        if not settings.consent or not levels:
            self._update_alert(
                alert["id"], status="active", activated_at=iso(now), local_only=1, level=-1, next_escalation_at=None
            )
            reason = "no contacts are set up" if not levels else "consent to contact people hasn't been given"
            self._event(
                alert["id"],
                "local_only",
                "system",
                f"Lifeline can't contact anyone because {reason}. Only the alarm on {self._person()}'s computer is sounding.",
            )
            return
        self._update_alert(
            alert["id"],
            status="active",
            activated_at=iso(now),
            level=0,
            cycle=0,
            next_escalation_at=iso(now + timedelta(seconds=settings.ack_timeout_s)),
        )
        self._event(alert["id"], "activated", "system", f"Alert started. Contacting {_names(levels[0])}.")
        fresh = self._alert_row(alert["id"])
        assert fresh is not None
        await self._notify(fresh, levels[0], purpose="alert", level=0, cycle=0)
        await self._fast_escalate(alert["id"], now)

    def _level_exhausted(self, alert: dict[str, Any]) -> bool:
        current = [
            n
            for n in self._notifications(alert["id"])
            if n["purpose"] == "alert" and n["level"] == alert["level"] and n["cycle"] == alert["cycle"]
        ]
        return bool(current) and all(n["status"] == "failed" or n["response"] == "declined" for n in current)

    async def _fast_escalate(self, alert_id: str, now: datetime) -> None:
        """Move on immediately when nobody at the current level can come or be reached."""
        levels = self.settings().levels()
        for _ in range(len(levels)):
            alert = self._alert_row(alert_id)
            if not alert or alert["status"] != "active" or not self._level_exhausted(alert):
                return
            if alert["level"] >= len(levels) - 1:
                self._event(
                    alert_id,
                    "unreachable",
                    "system",
                    f"Couldn't reach anyone who can come. Trying everyone again at {clock(parse(alert['next_escalation_at']))}. "
                    f"The alarm on {self._person()}'s computer keeps sounding.",
                )
                return
            await self._escalate(alert, now, reason="unreachable")

    async def _escalate(self, alert: dict[str, Any], now: datetime, *, reason: str) -> None:
        settings = self.settings()
        levels = settings.levels()
        if not levels:
            return
        level, cycle = alert["level"], alert["cycle"]
        previous = levels[min(max(level, 0), len(levels) - 1)] if cycle == 0 else settings.enabled_contacts()
        missed = _names(previous)
        if level + 1 >= len(levels):
            cycle += 1
            targets = settings.enabled_contacts()
            next_level = len(levels) - 1
            wait = settings.ack_timeout_s * 2
            self._update_alert(alert["id"], level=next_level, cycle=cycle, next_escalation_at=iso(now + timedelta(seconds=wait)))
            self._event(
                alert["id"],
                "escalated",
                "system",
                f"No one has answered yet. Alerting everyone again (round {cycle + 1}). "
                f"The alarm on {self._person()}'s computer keeps sounding.",
                {"round": cycle + 1},
            )
            context = "No one has answered yet. "
        else:
            next_level = level + 1
            targets = levels[next_level]
            wait = settings.ack_timeout_s
            self._update_alert(alert["id"], level=next_level, next_escalation_at=iso(now + timedelta(seconds=wait)))
            why = {
                "no_answer": f"didn't answer within {settings.ack_timeout_s} s",
                "unreachable": "couldn't be reached or can't come",
            }[reason]
            self._event(
                alert["id"],
                "escalated",
                "system",
                f"{missed} {why}. Now contacting {_names(targets)}.",
                {"level": next_level, "reason": reason},
            )
            context = f"{missed} {why}. "
        fresh = self._alert_row(alert["id"])
        assert fresh is not None
        await self._notify(fresh, targets, purpose="alert", level=next_level, cycle=cycle, context=context)

    async def cancel(self, alert_id: str) -> dict[str, Any]:
        async with self.lock:
            alert = self._alert_row(alert_id)
            if not alert:
                raise LifelineError("Alert not found.")
            if alert["status"] != "pending_cancel":
                raise LifelineError("This alert has already started. Use “I'm OK” so everyone gets an all-clear.")
            self._update_alert(alert_id, status="cancelled", resolved_at=iso(self.now()), resolved_by=self._person())
            self._event(
                alert_id, "cancelled", "user", f"Cancelled by {self._person()} during the countdown. No one was contacted."
            )
            return self.alert_detail(alert_id)

    async def activate_now(self, alert_id: str) -> dict[str, Any]:
        """The person chose "Call now" during the countdown."""
        async with self.lock:
            alert = self._alert_row(alert_id)
            if not alert:
                raise LifelineError("Alert not found.")
            if alert["status"] == "pending_cancel":
                self._event(alert_id, "call_now", "user", f"{self._person()} chose to call now instead of waiting.")
                await self._activate(alert, self.now())
            return self.alert_detail(alert_id)

    async def resolve(self, alert_id: str, *, by: str, actor: str, exclude_contact: str | None = None) -> dict[str, Any]:
        async with self.lock:
            return await self._resolve(alert_id, by=by, actor=actor, exclude_contact=exclude_contact)

    async def _resolve(self, alert_id: str, *, by: str, actor: str, exclude_contact: str | None = None) -> dict[str, Any]:
        alert = self._alert_row(alert_id)
        if not alert:
            raise LifelineError("Alert not found.")
        if alert["status"] in ("resolved", "cancelled"):
            return self.alert_detail(alert_id)
        if alert["status"] == "pending_cancel":
            self._update_alert(alert_id, status="cancelled", resolved_at=iso(self.now()), resolved_by=by)
            self._event(alert_id, "cancelled", actor, f"Cancelled by {by} during the countdown. No one was contacted.")
            return self.alert_detail(alert_id)
        now = self.now()
        self._update_alert(alert_id, status="resolved", resolved_at=iso(now), resolved_by=by, next_escalation_at=None)
        name = self._person()
        self._event(alert_id, "resolved", actor, f"Alert ended by {by}: {name} is safe.")
        recipients = self._sent_contacts(alert_id, exclude={exclude_contact} if exclude_contact else None)
        if recipients:
            await self._notify(
                alert,
                recipients,
                purpose="all_clear",
                level=-1,
                cycle=-1,
                extra=f"{name} is safe (ended by {by} at {clock(now)}).",
            )
            self._event(alert_id, "all_clear", "system", f"All-clear sent to {_names(recipients)}.")
        return self.alert_detail(alert_id)

    async def respond(self, token: str, action: str) -> tuple[dict[str, Any], dict[str, Any], str]:
        """A contact answered through their response link. Returns (alert, notification, outcome)."""
        async with self.lock:
            row = self.db.query_one("SELECT * FROM lifeline_notifications WHERE token = ?", (token,))
            if not row:
                raise LifelineError("This link isn't valid.")
            notification = dict(row)
            alert = self._alert_row(notification["alert_id"])
            assert alert is not None
            who = notification["contact_name"]
            now = self.now()
            if alert["status"] in ("resolved", "cancelled"):
                return self.alert_detail(alert["id"]), notification, "ended"
            if action == "ack":
                self.db.execute(
                    "UPDATE lifeline_notifications SET response = 'acknowledged', responded_at = ? WHERE id = ?",
                    (iso(now), notification["id"]),
                )
                if alert["status"] == "acknowledged":
                    self._event(alert["id"], "acknowledged_also", "contact", f"{who} is also on the way.")
                    return self.alert_detail(alert["id"]), notification, "ack_also"
                started = parse(alert["created_at"]) or now
                seconds = int((now - started).total_seconds())
                self._update_alert(
                    alert["id"], status="acknowledged", acknowledged_at=iso(now), acknowledged_by=who, next_escalation_at=None
                )
                self._event(
                    alert["id"],
                    "acknowledged",
                    "contact",
                    f"{who} answered: on the way ({seconds} s after the signal). Escalation stopped.",
                    {"contact": notification["contact_id"], "seconds": seconds},
                )
                others = self._sent_contacts(alert["id"], exclude={notification["contact_id"]})
                if others:
                    await self._notify(alert, others, purpose="stand_down", level=-1, cycle=-1, extra=who)
                    self._event(alert["id"], "stand_down", "system", f"Told {_names(others)} that {who} is handling it.")
                return self.alert_detail(alert["id"]), notification, "ack"
            if action == "decline":
                was_coming = notification["response"] == "acknowledged"
                self.db.execute(
                    "UPDATE lifeline_notifications SET response = 'declined', responded_at = ? WHERE id = ?",
                    (iso(now), notification["id"]),
                )
                if alert["status"] == "acknowledged" and was_coming:
                    await self._withdrawn(alert, who, now)
                else:
                    self._event(alert["id"], "declined", "contact", f"{who} can't come.", {"contact": notification["contact_id"]})
                if alert["status"] == "active":
                    await self._fast_escalate(alert["id"], now)
                return self.alert_detail(alert["id"]), notification, "decline"
            if action == "resolve":
                self.db.execute(
                    "UPDATE lifeline_notifications SET response = 'resolved', responded_at = ? WHERE id = ?",
                    (iso(now), notification["id"]),
                )
                detail = await self._resolve(alert["id"], by=who, actor="contact", exclude_contact=notification["contact_id"])
                return detail, notification, "resolve"
            raise LifelineError("Unknown response.")

    async def _withdrawn(self, alert: dict[str, Any], who: str, now: datetime) -> None:
        """Someone who said they were coming now can't. Never leave the alert covered by nobody."""
        still = [n for n in self._notifications(alert["id"]) if n["purpose"] == "alert" and n["response"] == "acknowledged"]
        if still:
            other = still[0]["contact_name"]
            self._update_alert(alert["id"], acknowledged_by=other)
            self._event(alert["id"], "declined", "contact", f"{who} can no longer come. {other} is still on the way.")
            return
        self._update_alert(alert["id"], status="active", acknowledged_at=None, acknowledged_by=None)
        self._event(
            alert["id"],
            "reopened",
            "contact",
            f"{who} can no longer come. The alert is open again and AGENCY is contacting the next person.",
        )
        fresh = self._alert_row(alert["id"])
        assert fresh is not None
        await self._escalate(fresh, now, reason="unreachable")

    # ------------------------------------------------------------------------------
    # watch over me: heartbeat, watchdog, check-ins
    # ------------------------------------------------------------------------------
    def _schedule_checkin(self, now: datetime) -> None:
        state = self.monitor()
        interval = self.settings().checkin_interval_min
        state["next_checkin_at"] = iso(now + timedelta(minutes=interval)) if interval else None
        state["checkin_pending_since"] = None
        self._save_monitor(state)

    async def set_armed(self, armed: bool) -> dict[str, Any]:
        async with self.lock:
            now = self.now()
            state = self.monitor()
            state.update(
                {
                    "armed": armed,
                    "armed_at": iso(now) if armed else None,
                    "last_heartbeat_at": iso(now),
                    "watchdog_alerted_for": None,
                    "signal_alerted_for": None,
                }
            )
            if not armed:
                # Nothing is watched while it's off, so nothing may stay waiting either.
                state.update({"checkin_pending_since": None, "next_checkin_at": None, "signal_unready_since": None})
            self._save_monitor(state)
            if armed:
                self._schedule_checkin(now)
            name = self._person()
            self._event(None, "monitoring", "user", f"Watch over me turned {'on' if armed else 'off'} for {name}.")
            return self.status()

    async def heartbeat(self, beat: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            now = self.now()
            state = self.monitor()
            was_alerted = state.get("watchdog_alerted_for")
            state["last_heartbeat_at"] = iso(now)
            state["last_heartbeat"] = beat
            if beat.get("signal_ready"):
                state["signal_unready_since"] = None
                state["signal_alerted_for"] = None
            elif not state.get("signal_unready_since"):
                state["signal_unready_since"] = iso(now)
            if was_alerted:
                state["watchdog_alerted_for"] = None
                open_alert = self._open_alert()
                if open_alert and open_alert["kind"] == "watchdog":
                    self._event(
                        open_alert["id"],
                        "interface_back",
                        "system",
                        f"{self._person()}'s computer is responding again. Someone should still check in person.",
                    )
            self._save_monitor(state)
            return {"ok": True, "server_time": iso(now)}

    async def checkin_ok(self, source: str) -> dict[str, Any]:
        async with self.lock:
            now = self.now()
            state = self.monitor()
            pending = state.get("checkin_pending_since")
            state["checkin_last_ok_at"] = iso(now)
            self._save_monitor(state)
            if pending:
                self._event(None, "checkin_ok", "user", f"{self._person()} answered the check-in ({source}).")
            if state.get("armed"):
                self._schedule_checkin(now)
            return self.status()

    async def checkin_now(self) -> dict[str, Any]:
        """Presenter control: ask for a check-in now (works even with no check-in schedule)."""
        async with self.lock:
            state = self.monitor()
            if not state.get("armed"):
                raise LifelineError("Turn on Watch over me first: check-ins only run while it's on.")
            if not state.get("checkin_pending_since"):
                state["checkin_pending_since"] = iso(self.now())
                self._save_monitor(state)
                self._event(None, "checkin_due", "system", f"Check-in: asking {self._person()} to confirm they're OK.")
            return self.status()

    # ------------------------------------------------------------------------------
    # the clock: called every second by the supervisor loop
    # ------------------------------------------------------------------------------
    async def tick(self) -> None:
        async with self.lock:
            now = self.now()
            for row in self.db.query("SELECT * FROM lifeline_alerts WHERE status = 'pending_cancel'"):
                alert = dict(row)
                if (parse(alert["activates_at"]) or now) <= now:
                    await self._activate(alert, now)
            for row in self.db.query("SELECT * FROM lifeline_alerts WHERE status = 'active' AND local_only = 0"):
                alert = dict(row)
                await self._simulated_operator(alert, now)
                alert = self._alert_row(alert["id"]) or alert
                due = parse(alert["next_escalation_at"])
                if alert["status"] == "active" and due and due <= now:
                    await self._escalate(alert, now, reason="no_answer")
                    await self._fast_escalate(alert["id"], now)
            await self._watch(now)

    async def _simulated_operator(self, alert: dict[str, Any], now: datetime) -> None:
        """The Demo Monitoring Center (a simulated service) answers like a staffed centre would."""
        for n in self._notifications(alert["id"]):
            if (
                n["purpose"] == "alert"
                and n["channel"] == "demo"
                and n["contact_role"] == "monitoring_service"
                and n["status"] == "delivered"
                and not n["response"]
                and (parse(n["sent_at"]) or now) + timedelta(seconds=DEMO_OPERATOR_DELAY_S) <= now
            ):
                self.db.execute(
                    "UPDATE lifeline_notifications SET response = 'acknowledged', responded_at = ? WHERE id = ?",
                    (iso(now), n["id"]),
                )
                seconds = int((now - (parse(alert["created_at"]) or now)).total_seconds())
                who = f"{n['contact_name']} operator"
                self._update_alert(
                    alert["id"], status="acknowledged", acknowledged_at=iso(now), acknowledged_by=who, next_escalation_at=None
                )
                self._event(
                    alert["id"],
                    "acknowledged",
                    "contact",
                    f"{who} answered ({seconds} s after the signal): calling {self._person()}'s contacts and ready to "
                    "send emergency services. (Simulated monitoring service.)",
                    {"contact": n["contact_id"], "seconds": seconds, "simulated": True},
                )
                others = self._sent_contacts(alert["id"], exclude={n["contact_id"]})
                if others:
                    await self._notify(alert, others, purpose="stand_down", level=-1, cycle=-1, extra=who)
                return

    async def _watch(self, now: datetime) -> None:
        state = self.monitor()
        if not state.get("armed"):
            return
        settings = self.settings()
        open_alert = self._open_alert()
        last = parse(state.get("last_heartbeat_at")) or now
        if not open_alert and (now - last).total_seconds() > settings.watchdog_timeout_s:
            if state.get("watchdog_alerted_for") != state.get("last_heartbeat_at"):
                state["watchdog_alerted_for"] = state.get("last_heartbeat_at")
                self._save_monitor(state)
                await self._create("watchdog", "watchdog")
                return
        since = parse(state.get("signal_unready_since"))
        if (
            not open_alert
            and settings.alert_on_signal_unavailable
            and since
            and (now - since).total_seconds() > settings.signal_grace_s
            and state.get("signal_alerted_for") != state.get("signal_unready_since")
        ):
            state["signal_alerted_for"] = state.get("signal_unready_since")
            self._save_monitor(state)
            await self._create("signal_unavailable", "watchdog")
            return
        due = parse(state.get("next_checkin_at"))
        pending = parse(state.get("checkin_pending_since"))
        if pending:
            if (now - pending).total_seconds() > settings.checkin_response_s:
                self._schedule_checkin(now)
                if not open_alert:
                    self._event(None, "checkin_missed", "system", f"{self._person()} didn't answer the check-in.")
                    await self._create("checkin_missed", "checkin")
        elif settings.checkin_interval_min and due and due <= now:
            state["checkin_pending_since"] = iso(now)
            self._save_monitor(state)
            self._event(None, "checkin_due", "system", f"Check-in: asking {self._person()} to confirm they're OK.")

    async def run(self, interval_s: float = 1.0) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # keep the safety loop alive no matter what
                log.exception("lifeline tick failed")
            await asyncio.sleep(interval_s)

    # ------------------------------------------------------------------------------
    # read models
    # ------------------------------------------------------------------------------
    def _metrics(self, alert: dict[str, Any], notifications: list[dict[str, Any]]) -> dict[str, Any]:
        created = parse(alert["created_at"])
        sent = sorted(t for n in notifications if n["purpose"] == "alert" and (t := parse(n["sent_at"])) is not None)
        acked = parse(alert["acknowledged_at"])
        return {
            "seconds_to_first_contact": round((sent[0] - created).total_seconds(), 1) if sent and created else None,
            "seconds_to_acknowledged": round((acked - created).total_seconds(), 1) if acked and created else None,
            "people_alerted": len(
                {n["contact_id"] for n in notifications if n["purpose"] == "alert" and n["status"] != "failed"}
            ),
        }

    def alert_detail(self, alert_id: str) -> dict[str, Any]:
        alert = self._alert_row(alert_id)
        if not alert:
            raise LifelineError("Alert not found.")
        notifications = self._notifications(alert_id)
        events = [
            {
                "id": r["id"],
                "ts": r["ts"],
                "kind": r["kind"],
                "actor": r["actor"],
                "message": r["message"],
                "data": loads(r["data"]),
            }
            for r in self.db.query("SELECT * FROM lifeline_events WHERE alert_id = ? ORDER BY id", (alert_id,))
        ]
        public = [{k: v for k, v in n.items() if k != "token"} | {"has_link": bool(n["token"])} for n in notifications]
        waiting = [
            n["contact_name"]
            for n in notifications
            if n["purpose"] == "alert"
            and n["level"] == alert["level"]
            and n["cycle"] == alert["cycle"]
            and n["status"] != "failed"
            and not n["response"]
        ]
        return {
            **alert,
            "is_test": bool(alert["is_test"]),
            "local_only": bool(alert["local_only"]),
            "what": self._what(alert),
            "notifications": public,
            "events": events,
            "waiting_on": waiting if alert["status"] == "active" else [],
            "metrics": self._metrics(alert, notifications),
        }

    def find_notification(self, token: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        if not token or len(token) > 64:
            return None
        row = self.db.query_one("SELECT * FROM lifeline_notifications WHERE token = ?", (token,))
        if not row:
            return None
        return dict(row), self.alert_detail(row["alert_id"])

    def on_startup(self) -> None:
        """Record that the coordinator restarted; open alerts carry on from their stored timers."""
        alert = self._open_alert()
        if alert:
            self._event(
                alert["id"],
                "coordinator_restarted",
                "system",
                "The coordinator restarted. This alert is still open and escalation carries on.",
            )
        state = self.monitor()
        if state.get("armed"):
            # A restart isn't the person's computer going quiet: give it a full watchdog period.
            state["last_heartbeat_at"] = iso(self.now())
            self._save_monitor(state)
            self._event(None, "coordinator_restarted", "system", "The coordinator restarted. Watch over me is still on.")

    def recent(self, limit: int = 10) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM lifeline_alerts ORDER BY created_at DESC LIMIT ?", (limit,))
        out = []
        for r in rows:
            alert = dict(r)
            out.append(
                {
                    **alert,
                    "is_test": bool(alert["is_test"]),
                    "local_only": bool(alert["local_only"]),
                    "what": self._what(alert),
                    "metrics": self._metrics(alert, self._notifications(alert["id"])),
                }
            )
        return out

    def problems(self) -> list[str]:
        s = self.settings()
        issues: list[str] = []
        if not s.enabled_contacts():
            issues.append("No contacts are set up, so Lifeline can only sound the alarm on this computer.")
        if not s.consent:
            issues.append("Consent hasn't been given for AGENCY to contact people without asking. Confirm it in Lifeline setup.")
        real = [c for c in s.enabled_contacts() if c.channel != "demo"]
        if real and not self.channels.twilio_configured:
            issues.append(
                f"{_names(real)} {'is' if len(real) == 1 else 'are'} set to real text messages, but Twilio isn't configured. "
                "Those alerts will fail and AGENCY will move straight to the next person."
            )
        if real and ("127.0.0.1" in self.public_url or "localhost" in self.public_url):
            issues.append("Response links point to this computer only, so phones can't open them. Set AGENCY_PUBLIC_URL.")
        return issues

    def status(self) -> dict[str, Any]:
        now = self.now()
        s = self.settings()
        state = self.monitor()
        open_alert = self._open_alert()
        last = parse(state.get("last_heartbeat_at"))
        return {
            "server_time": iso(now),
            "settings": s.model_dump(),
            "ready": not self.problems(),
            "problems": self.problems(),
            "channels": {"twilio_configured": self.channels.twilio_configured, "public_url": self.public_url},
            "monitor": {
                "armed": bool(state.get("armed")),
                "armed_at": state.get("armed_at"),
                "last_heartbeat_at": state.get("last_heartbeat_at"),
                "seconds_since_heartbeat": round((now - last).total_seconds(), 1) if last else None,
                "last_heartbeat": state.get("last_heartbeat"),
                "signal_unready_since": state.get("signal_unready_since"),
                "next_checkin_at": state.get("next_checkin_at"),
                "checkin_pending_since": state.get("checkin_pending_since"),
                "checkin_last_ok_at": state.get("checkin_last_ok_at"),
            },
            "open_alert": self.alert_detail(open_alert["id"]) if open_alert else None,
            "recent": self.recent(8),
        }

    def outbox(self) -> list[dict[str, Any]]:
        """Messages to simulated phones, with their (real, working) response links."""
        rows = self.db.query(
            "SELECT n.*, a.status AS alert_status, a.is_test FROM lifeline_notifications n "
            "JOIN lifeline_alerts a ON a.id = n.alert_id WHERE n.channel = 'demo' AND n.status != 'failed' ORDER BY n.created_at DESC, n.rowid DESC LIMIT 60"
        )
        return [
            {
                "id": r["id"],
                "alert_id": r["alert_id"],
                "contact_id": r["contact_id"],
                "contact_name": r["contact_name"],
                "purpose": r["purpose"],
                "status": r["status"],
                "body": r["body"],
                "created_at": r["created_at"],
                "response": r["response"],
                "alert_status": r["alert_status"],
                "is_test": bool(r["is_test"]),
                "link": f"/respond/{r['token']}" if r["token"] else None,
            }
            for r in rows
        ]

    def report(self) -> dict[str, Any]:
        rows = [dict(r) for r in self.db.query("SELECT * FROM lifeline_alerts ORDER BY created_at")]
        acked = []
        for a in rows:
            m = self._metrics(a, self._notifications(a["id"]))
            if m["seconds_to_acknowledged"] is not None:
                acked.append(m["seconds_to_acknowledged"])
        return {
            "alerts": len(rows),
            "tests": sum(1 for a in rows if a["is_test"]),
            "real": sum(1 for a in rows if not a["is_test"]),
            "cancelled_in_countdown": sum(1 for a in rows if a["status"] == "cancelled"),
            "acknowledged": len(acked),
            "local_only": sum(1 for a in rows if a["local_only"]),
            "open": sum(1 for a in rows if a["status"] in OPEN),
            "median_seconds_to_acknowledged": round(statistics.median(acked), 1) if acked else None,
            "max_seconds_to_acknowledged": max(acked) if acked else None,
            "by_kind": {
                k: sum(1 for a in rows if a["kind"] == k) for k in ("help", "watchdog", "checkin_missed", "signal_unavailable")
            },
        }
