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
from .dispatch import DemoDispatch, DispatchInfo, DispatchProvider
from .home import DemoHome, HomeProvider
from .models import Contact, LifelineSettings
from .rescue import (
    AMBULANCE_QUESTION,
    ANSWERS,
    PRESET_QUESTIONS,
    SITUATIONS,
    URGENCY_RANK,
    handoff,
    plan_key,
    situation_label,
    situation_urgency,
)

log = logging.getLogger("agency.lifeline")

OPEN = ("pending_cancel", "active", "acknowledged")
MONITOR_KEY = "lifeline_monitor"
SETTINGS_KEY = "lifeline_settings"
HOME_KEY = "lifeline_home"
POWER_KEY = "lifeline_power"
DEMO_OPERATOR_DELAY_S = 12
POWER_CHECK_EVERY_S = 5
MAX_OPEN_QUESTIONS = 3
ACTIVE_DISPATCH = ("requested", "accepted")


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
    def __init__(
        self,
        db: Database,
        channels: ChannelRouter,
        *,
        public_url: str,
        dispatch: DispatchProvider | None = None,
        home: HomeProvider | None = None,
        network: Any = None,
    ) -> None:
        self.db = db
        # agency.network.NetworkMonitor (Cisco sentinel or AGENCY's own check), when watching is set up.
        self.network = network
        self.channels = channels
        self.public_url = public_url.rstrip("/")
        self.lock = asyncio.Lock()
        self.now: Callable[[], datetime] = lambda: datetime.now(UTC)
        self.dispatch: DispatchProvider = dispatch or DemoDispatch()
        self.home: HomeProvider = home or DemoHome(db, channels.demo.faults, lambda: self.now())
        self._power_checked_at: datetime | None = None
        self._home_cache: dict[str, Any] | None = None

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
        # Permission to request emergency services is separate, and also timestamped here.
        if new.dispatch.consent and not old.dispatch.consent:
            dispatch_at: str | None = iso(self.now())
        elif new.dispatch.consent:
            dispatch_at = old.dispatch.consented_at
        else:
            dispatch_at = None
        new = new.model_copy(update={"dispatch": new.dispatch.model_copy(update={"consented_at": dispatch_at})})
        self.db.set_state(SETTINGS_KEY, new.model_dump())
        changes = []
        if new.consent != old.consent:
            changes.append("consent given" if new.consent else "consent withdrawn")
        if new.dispatch.consent != old.dispatch.consent:
            changes.append(
                "permission to request emergency services given"
                if new.dispatch.consent
                else "permission to request emergency services withdrawn"
            )
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
        if kind == "power_lost":
            return f"{name}'s ventilator lost mains power at {when}"
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
        if purpose == "update":
            body = f"{'TEST: ' if test else ''}AGENCY Lifeline update for {name}: {extra} Use the link in the first message."
            return body, body
        what = self._what(alert)
        if alert.get("detail"):
            what += f". {alert['detail'].rstrip('.')}"
        if alert.get("situation") in SITUATIONS:
            what += f". {name} says: {situation_label(alert['situation']).lower()}"
        if alert.get("urgency") == "critical" and not test:
            prefix_critical = "CRITICAL. "
        else:
            prefix_critical = ""
        action = "Open the link and press I'm on my way to complete the test." if test else f"Please check on {name} now."
        prefix = "TEST from AGENCY Lifeline (not an emergency): " if test else f"AGENCY ALERT: {prefix_critical}"
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

    async def _create(
        self,
        kind: str,
        source: str,
        *,
        is_test: bool = False,
        situation: str | None = None,
        urgency: str | None = None,
        detail: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
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
            "power_lost": "Ventilator lost mains power",
        }[kind]
        urgency = urgency or situation_urgency(situation)
        self.db.execute(
            "INSERT INTO lifeline_alerts(id, kind, source, is_test, status, message, created_at, activates_at, updated_at,"
            " situation, urgency, critical_since, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
                situation,
                urgency,
                iso(now) if urgency == "critical" else None,
                detail,
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
        everyone = alert.get("urgency") == "critical" and settings.critical_alert_everyone and len(levels) > 1
        level = len(levels) - 1 if everyone else 0
        targets = settings.enabled_contacts() if everyone else levels[0]
        self._update_alert(
            alert["id"],
            status="active",
            activated_at=iso(now),
            level=level,
            cycle=0,
            next_escalation_at=iso(now + timedelta(seconds=settings.ack_timeout_s)),
        )
        if everyone:
            self._event(
                alert["id"], "activated", "system", f"Critical alert started. Contacting everyone at once: {_names(targets)}."
            )
        else:
            self._event(alert["id"], "activated", "system", f"Alert started. Contacting {_names(targets)}.")
        fresh = self._alert_row(alert["id"])
        assert fresh is not None
        await self._lights_on(fresh)
        await self._notify(fresh, targets, purpose="alert", level=level, cycle=0)
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
        active_dispatch = self._active_dispatch(alert_id)
        dispatch_note = ""
        if active_dispatch:
            dispatch_note = " Emergency services were requested and have not been cancelled."
            self._event(
                alert_id,
                "dispatch_still_active",
                "system",
                "Emergency services were requested and the request was not cancelled. Cancel it, or tell them directly, "
                "if they're no longer needed.",
            )
        await self._relock(alert_id, "the alert ended")
        recipients = self._sent_contacts(alert_id, exclude={exclude_contact} if exclude_contact else None)
        if recipients:
            await self._notify(
                alert,
                recipients,
                purpose="all_clear",
                level=-1,
                cycle=-1,
                extra=f"{name} is safe (ended by {by} at {clock(now)}).{dispatch_note}",
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
                outcome = await self._ack(alert, notification, now)
                return self.alert_detail(alert["id"]), notification, outcome
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

    async def _ack(self, alert: dict[str, Any], notification: dict[str, Any], now: datetime) -> str:
        who = notification["contact_name"]
        self.db.execute(
            "UPDATE lifeline_notifications SET response = 'acknowledged', responded_at = ? WHERE id = ?",
            (iso(now), notification["id"]),
        )
        notification["response"] = "acknowledged"
        if alert["status"] == "acknowledged":
            self._event(alert["id"], "acknowledged_also", "contact", f"{who} is also on the way.")
            return "ack_also"
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
        return "ack"

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
    # rescue: what's wrong, questions, steps, arrival, emergency services, the home
    # ------------------------------------------------------------------------------
    def _require_open(self, alert_id: str) -> dict[str, Any]:
        alert = self._alert_row(alert_id)
        if not alert:
            raise LifelineError("Alert not found.")
        if alert["status"] not in OPEN:
            raise LifelineError("This alert has already ended.")
        return alert

    def _by_token(self, token: str) -> tuple[dict[str, Any], dict[str, Any]]:
        row = self.db.query_one("SELECT * FROM lifeline_notifications WHERE token = ?", (token,)) if token else None
        if not row:
            raise LifelineError("This link isn't valid.")
        alert = self._alert_row(row["alert_id"])
        assert alert is not None
        return dict(row), alert

    def _plan_steps(self, key: str) -> list[str]:
        plans = self.settings().plans
        return list(plans.get(key) or plans.get("general") or [])  # type: ignore[call-overload]

    async def _update_contacts(self, alert: dict[str, Any], text: str) -> None:
        """Tell everyone who has been alerted (and could be reached) about a change."""
        recipients = self._sent_contacts(alert["id"])
        if recipients:
            fresh = self._alert_row(alert["id"]) or alert
            await self._notify(fresh, recipients, purpose="update", level=-1, cycle=-1, extra=text)

    async def set_situation(self, alert_id: str, situation: str) -> dict[str, Any]:
        """The person says what's wrong, with their eyes."""
        async with self.lock:
            alert = self._require_open(alert_id)
            await self._set_situation(alert, situation)
            return self.alert_detail(alert_id)

    async def _set_situation(self, alert: dict[str, Any], situation: str) -> None:
        now = self.now()
        name = self._person()
        label = situation_label(situation)
        target = situation_urgency(situation)
        current = alert.get("urgency") or "standard"
        upgrade = URGENCY_RANK[target] > URGENCY_RANK.get(current, 0)
        urgency = target if upgrade else current
        fields: dict[str, Any] = {"situation": situation, "urgency": urgency}
        becomes_critical = upgrade and urgency == "critical"
        if becomes_critical:
            fields["critical_since"] = iso(now)
        self._update_alert(alert["id"], **fields)
        self._event(
            alert["id"],
            "situation",
            "user",
            f"{name} says: {label.lower()}." + (" This is critical." if becomes_critical else ""),
            {"situation": situation, "urgency": urgency},
        )
        fresh = self._alert_row(alert["id"])
        assert fresh is not None
        if fresh["status"] == "pending_cancel":
            if urgency == "critical":
                self._event(alert["id"], "call_now", "system", "Critical, so the alert starts now instead of waiting.")
                await self._activate(fresh, now)
            return
        await self._update_contacts(fresh, f"{name} says: {label.lower()}{' (critical)' if urgency == 'critical' else ''}.")
        if becomes_critical and fresh["status"] == "active":
            await self._everyone_now(fresh, now, f"{name} says: {label.lower()}. ")

    async def _everyone_now(self, alert: dict[str, Any], now: datetime, context: str) -> None:
        """A critical alert nobody has answered: alert everyone not yet alerted in this round, at once."""
        settings = self.settings()
        levels = settings.levels()
        if not settings.critical_alert_everyone or not levels:
            return
        tried = {
            n["contact_id"] for n in self._notifications(alert["id"]) if n["purpose"] == "alert" and n["cycle"] == alert["cycle"]
        }
        targets = [c for c in settings.enabled_contacts() if c.id not in tried]
        self._update_alert(
            alert["id"], level=len(levels) - 1, next_escalation_at=iso(now + timedelta(seconds=settings.ack_timeout_s))
        )
        if not targets:
            return
        self._event(alert["id"], "escalated", "system", f"Critical: alerting everyone at once. Now contacting {_names(targets)}.")
        fresh = self._alert_row(alert["id"])
        assert fresh is not None
        await self._notify(fresh, targets, purpose="alert", level=len(levels) - 1, cycle=alert["cycle"], context=context)

    # -- questions: a helper asks, the person answers with their eyes ------------------------
    async def ask(self, token: str, text: str) -> tuple[dict[str, Any], dict[str, Any], str]:
        async with self.lock:
            notification, alert = self._by_token(token)
            if alert["status"] not in OPEN:
                return self.alert_detail(alert["id"]), notification, "ended"
            text = " ".join(text.split())[:140]
            if len(text) < 3:
                raise LifelineError("Type a question with at least a few words.")
            waiting = self.db.query_one(
                "SELECT COUNT(*) AS n FROM lifeline_questions WHERE alert_id = ? AND answer IS NULL", (alert["id"],)
            )
            if waiting and waiting["n"] >= MAX_OPEN_QUESTIONS:
                return self.alert_detail(alert["id"]), notification, "too_many"
            who = notification["contact_name"]
            self.db.execute(
                "INSERT INTO lifeline_questions(id, alert_id, contact_id, asked_by, text, asked_at) VALUES (?,?,?,?,?,?)",
                (f"q_{secrets.token_hex(5)}", alert["id"], notification["contact_id"], who, text, iso(self.now())),
            )
            self._event(alert["id"], "question", "contact", f"{who} asks {self._person()}: {text}")
            return self.alert_detail(alert["id"]), notification, "asked"

    async def answer(self, question_id: str, answer: str) -> dict[str, Any]:
        async with self.lock:
            row = self.db.query_one("SELECT * FROM lifeline_questions WHERE id = ?", (question_id,))
            if not row:
                raise LifelineError("Question not found.")
            alert = self._alert_row(row["alert_id"])
            assert alert is not None
            if row["answer"]:
                return self.alert_detail(alert["id"])
            if alert["status"] not in OPEN:
                raise LifelineError("This alert has already ended.")
            name = self._person()
            self.db.execute(
                "UPDATE lifeline_questions SET answer = ?, answered_at = ? WHERE id = ?", (answer, iso(self.now()), question_id)
            )
            self._event(
                alert["id"],
                "answer",
                "user",
                f"{name} answered {ANSWERS[answer]}: {row['text']}",
                {"question": question_id, "answer": answer, "asked_by": row["asked_by"]},
            )
            if row["text"] == AMBULANCE_QUESTION and answer == "yes":
                await self._request_dispatch(
                    alert, requested_by=name, reason=f'{name} answered yes to "{AMBULANCE_QUESTION}" ({row["asked_by"]} asked)'
                )
            return self.alert_detail(alert["id"])

    # -- the helper's checklist and arrival ---------------------------------------------------
    async def step_done(self, token: str, step: int) -> tuple[dict[str, Any], dict[str, Any], str]:
        async with self.lock:
            notification, alert = self._by_token(token)
            if alert["status"] not in OPEN:
                return self.alert_detail(alert["id"]), notification, "ended"
            key = plan_key(alert["situation"])
            steps = self._plan_steps(key)
            if not 0 <= step < len(steps):
                raise LifelineError("That step doesn't exist.")
            who = notification["contact_name"]
            existing = self.db.query_one(
                "SELECT 1 FROM lifeline_steps WHERE alert_id = ? AND plan = ? AND step = ?", (alert["id"], key, step)
            )
            if not existing:
                self.db.execute(
                    "INSERT INTO lifeline_steps(alert_id, plan, step, label, done_by, done_at) VALUES (?,?,?,?,?,?)",
                    (alert["id"], key, step, steps[step], who, iso(self.now())),
                )
                self._event(alert["id"], "step_done", "contact", f"{who} did: {steps[step]}", {"plan": key, "step": step})
            return self.alert_detail(alert["id"]), notification, "step"

    async def arrived(self, token: str) -> tuple[dict[str, Any], dict[str, Any], str]:
        async with self.lock:
            notification, alert = self._by_token(token)
            if alert["status"] not in OPEN:
                return self.alert_detail(alert["id"]), notification, "ended"
            now = self.now()
            who = notification["contact_name"]
            if notification["response"] != "acknowledged":
                await self._ack(alert, notification, now)
                alert = self._alert_row(alert["id"]) or alert
            if not notification.get("arrived_at"):
                self.db.execute("UPDATE lifeline_notifications SET arrived_at = ? WHERE id = ?", (iso(now), notification["id"]))
                started = parse(alert["created_at"]) or now
                seconds = int((now - started).total_seconds())
                self._event(
                    alert["id"],
                    "arrived",
                    "contact",
                    f"{who} is with {self._person()} now ({seconds} s after the signal).",
                    {"contact": notification["contact_id"], "seconds": seconds},
                )
            return self.alert_detail(alert["id"]), notification, "arrived"

    # -- emergency services -----------------------------------------------------------------
    def _dispatch_rows(self, alert_id: str) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self.db.query("SELECT * FROM lifeline_dispatch WHERE alert_id = ? ORDER BY requested_at, rowid", (alert_id,))
        ]

    def _active_dispatch(self, alert_id: str) -> dict[str, Any] | None:
        rows = [r for r in self._dispatch_rows(alert_id) if r["status"] in ACTIVE_DISPATCH]
        return rows[-1] if rows else None

    def _dispatch_info(self) -> DispatchInfo:
        s = self.settings()
        contacts = [(c.name, c.address) for c in s.enabled_contacts() if c.channel != "demo" and c.address]
        return DispatchInfo(
            name=s.responder.person_name or "Unknown",
            phone=s.dispatch.phone,
            address=s.dispatch.address,
            entry=s.dispatch.entry,
            pin=s.dispatch.pin,
            contacts=contacts,
        )

    def _insert_dispatch(self, alert_id: str, **fields: Any) -> dict[str, Any]:
        now = iso(self.now())
        row = {
            "id": f"dsp_{secrets.token_hex(4)}",
            "alert_id": alert_id,
            "provider": self.dispatch.name,
            "simulated": 1 if self.dispatch.simulated else 0,
            "status": "requested",
            "reason": "",
            "requested_by": "",
            "provider_ref": None,
            "error": None,
            "note": None,
            "requested_at": now,
            "updated_at": now,
            **fields,
        }
        cols = ", ".join(row)
        self.db.execute(
            f"INSERT INTO lifeline_dispatch({cols}) VALUES ({', '.join('?' for _ in row)})",  # noqa: S608 - fixed column names
            list(row.values()),
        )
        return row

    async def request_dispatch(self, alert_id: str, *, requested_by: str, reason: str) -> dict[str, Any]:
        async with self.lock:
            alert = self._require_open(alert_id)
            await self._request_dispatch(alert, requested_by=requested_by, reason=reason)
            return self.alert_detail(alert_id)

    async def _request_dispatch(self, alert: dict[str, Any], *, requested_by: str, reason: str) -> dict[str, Any]:
        rows = self._dispatch_rows(alert["id"])
        if rows and rows[-1]["status"] in (*ACTIVE_DISPATCH, "test_skipped"):
            return rows[-1]
        settings = self.settings()
        name = self._person()
        number = settings.emergency_number
        now = self.now()
        if alert["status"] == "pending_cancel":
            await self._activate(alert, now)
            alert = self._alert_row(alert["id"]) or alert
        if alert["is_test"]:
            self._event(
                alert["id"],
                "dispatch_test",
                "system",
                f"Test alert: in a real alert AGENCY would now request emergency services ({reason}). Nothing was sent.",
            )
            return self._insert_dispatch(
                alert["id"], provider="test", simulated=1, status="test_skipped", reason=reason, requested_by=requested_by
            )
        if not settings.dispatch.consent:
            self._event(
                alert["id"],
                "dispatch_not_allowed",
                "system",
                f"Emergency services were not requested: {name} hasn't allowed AGENCY to request them. "
                f"Call {number} if {name} needs them.",
            )
            await self._update_contacts(
                alert, f"AGENCY is not allowed to request emergency services. Call {number} if {name} needs them."
            )
            return self._insert_dispatch(alert["id"], status="not_allowed", reason=reason, requested_by=requested_by)
        result = await self.dispatch.request(self._dispatch_info())
        row = self._insert_dispatch(
            alert["id"],
            status=result.status,
            reason=reason,
            requested_by=requested_by,
            provider_ref=result.provider_ref,
            error=result.error,
            note=result.note,
            simulated=1 if result.simulated else 0,
        )
        sim = " (simulated)" if result.simulated else ""
        if result.status == "requested":
            self._event(
                alert["id"],
                "dispatch_requested",
                "system",
                f"Emergency services requested from {self.dispatch.name}{sim}. Why: {reason}. "
                f"Address: {settings.dispatch.address.one_line() or 'not set'}.",
                {"dispatch": row["id"], "ref": result.provider_ref},
            )
            await self._update_contacts(alert, f"emergency services have been requested from {self.dispatch.name}{sim}.")
            if settings.home.unlock_for_emergency_services and self.home.has_lock:
                await self._unlock(alert, for_whom="emergency services", minutes=settings.home.relock_after_min * 2)
        else:
            self._event(
                alert["id"],
                "dispatch_failed",
                "system",
                f"AGENCY could NOT request emergency services: {result.error} Call {number} if {name} needs them.",
            )
            await self._update_contacts(
                alert, f"AGENCY could not request emergency services ({result.error}). Call {number} if {name} needs them."
            )
        return row

    async def dispatch_by_token(self, token: str) -> tuple[dict[str, Any], dict[str, Any], str]:
        """A contact asks for (simulated) emergency services from their response page."""
        async with self.lock:
            notification, alert = self._by_token(token)
            if alert["status"] not in OPEN:
                return self.alert_detail(alert["id"]), notification, "ended"
            who = notification["contact_name"]
            row = await self._request_dispatch(alert, requested_by=who, reason=f"{who} asked for emergency services")
            outcome = {"requested": "dispatched", "accepted": "dispatched", "test_skipped": "dispatch_test"}.get(
                row["status"], "dispatch_failed"
            )
            return self.alert_detail(alert["id"]), notification, outcome

    async def cancel_dispatch_by_token(self, token: str) -> tuple[dict[str, Any], dict[str, Any], str]:
        notification, alert = self._by_token(token)
        try:
            detail = await self.cancel_dispatch(alert["id"], by=notification["contact_name"])
        except LifelineError:
            return self.alert_detail(alert["id"]), notification, "dispatch_cancel_failed"
        return detail, notification, "dispatch_cancelled"

    async def cancel_dispatch(self, alert_id: str, *, by: str) -> dict[str, Any]:
        async with self.lock:
            alert = self._alert_row(alert_id)
            if not alert:
                raise LifelineError("Alert not found.")
            row = self._active_dispatch(alert_id)
            if not row:
                raise LifelineError("There is no emergency services request to cancel.")
            if row["provider"] == self.dispatch.name:
                result = await self.dispatch.cancel(row["provider_ref"] or "", self.settings().dispatch.pin)
            else:
                result = None
            now = iso(self.now())
            if result is not None and result.status == "failed":
                self._event(
                    alert_id,
                    "dispatch_cancel_failed",
                    "system",
                    f"Couldn't cancel the emergency services request: {result.error} Contact them directly.",
                )
                raise LifelineError(f"Couldn't cancel the request: {result.error} Contact them directly.")
            self.db.execute("UPDATE lifeline_dispatch SET status = 'cancelled', updated_at = ? WHERE id = ?", (now, row["id"]))
            self._event(alert_id, "dispatch_cancelled", "user", f"Emergency services request cancelled by {by}.")
            await self._update_contacts(alert, f"the emergency services request was cancelled by {by}.")
            return self.alert_detail(alert_id)

    async def _dispatch_watch(self, now: datetime) -> None:
        settings = self.settings()
        # The simulated dispatch centre confirms a few seconds after a request.
        for row in self.db.query(
            "SELECT * FROM lifeline_dispatch WHERE status = 'requested' AND provider = ?", (DemoDispatch.name,)
        ):
            if (parse(row["requested_at"]) or now) + timedelta(seconds=DemoDispatch.accept_after_s) <= now:
                note = f"Dispatcher confirmed: an ambulance is on the way, about {DemoDispatch.eta_min} minutes (simulated)."
                self.db.execute(
                    "UPDATE lifeline_dispatch SET status = 'accepted', note = ?, updated_at = ? WHERE id = ?",
                    (note, iso(now), row["id"]),
                )
                self._event(row["alert_id"], "dispatch_accepted", "system", note)
        # Critical and nobody has answered: ask for emergency services, if allowed.
        if not settings.dispatch.auto_after_s:
            return
        for row in self.db.query(
            "SELECT * FROM lifeline_alerts WHERE status = 'active' AND urgency = 'critical' AND critical_since IS NOT NULL"
        ):
            alert = dict(row)
            since = parse(alert["critical_since"]) or now
            if (now - since).total_seconds() >= settings.dispatch.auto_after_s and not self._dispatch_rows(alert["id"]):
                await self._request_dispatch(
                    alert,
                    requested_by="AGENCY",
                    reason=f"critical alert and no one answered within {settings.dispatch.auto_after_s} s",
                )

    # -- the home -------------------------------------------------------------------------------
    def _home_state(self) -> dict[str, Any]:
        state: dict[str, Any] = self.db.get_state(HOME_KEY, {}) or {}
        return state

    async def _lights_on(self, alert: dict[str, Any]) -> None:
        if alert["is_test"] or not self.settings().home.lights_on_alert or not self.home.has_lights:
            return
        result = await self.home.lights_on()
        if result.ok:
            self._event(alert["id"], "lights_on", "system", "Turned the lights on so helpers can see.")
        else:
            self._event(alert["id"], "home_failed", "system", f"Couldn't turn the lights on: {result.error}")

    async def unlock_for(self, token: str) -> tuple[dict[str, Any], dict[str, Any], str]:
        async with self.lock:
            notification, alert = self._by_token(token)
            if alert["status"] not in OPEN:
                return self.alert_detail(alert["id"]), notification, "ended"
            settings = self.settings()
            who = notification["contact_name"]
            if not (settings.home.unlock_for_responders and self.home.has_lock):
                return self.alert_detail(alert["id"]), notification, "unlock_not_allowed"
            if notification["response"] != "acknowledged":
                return self.alert_detail(alert["id"]), notification, "unlock_needs_ack"
            if alert["is_test"]:
                self._event(alert["id"], "unlock_test", "contact", f"Test alert: the front door would be unlocked for {who} now.")
                return self.alert_detail(alert["id"]), notification, "unlock_test"
            ok = await self._unlock(alert, for_whom=who, minutes=settings.home.relock_after_min)
            return self.alert_detail(alert["id"]), notification, "unlocked" if ok else "unlock_failed"

    async def _unlock(self, alert: dict[str, Any], *, for_whom: str, minutes: int) -> bool:
        result = await self.home.unlock()
        if not result.ok:
            self._event(alert["id"], "home_failed", "system", f"Couldn't unlock the front door: {result.error}")
            return False
        relock_at = self.now() + timedelta(minutes=minutes)
        self.db.set_state(HOME_KEY, {"alert_id": alert["id"], "relock_at": iso(relock_at), "for": for_whom})
        self._event(
            alert["id"],
            "door_unlocked",
            "system",
            f"Front door unlocked for {for_whom}. It locks again at {clock(relock_at)}, or when the alert ends.",
        )
        return True

    async def _relock(self, alert_id: str | None, why: str) -> None:
        state = self._home_state()
        if not state.get("alert_id") or (alert_id and state["alert_id"] != alert_id):
            return
        result = await self.home.lock()
        self.db.set_state(HOME_KEY, {} if result.ok else state)
        if result.ok:
            self._event(state["alert_id"], "door_locked", "system", f"Front door locked again ({why}).")
        else:
            self._event(state["alert_id"], "home_failed", "system", f"Couldn't lock the front door again: {result.error}")

    async def _home_watch(self, now: datetime) -> None:
        state = self._home_state()
        relock_at = parse(state.get("relock_at"))
        if relock_at and relock_at <= now:
            await self._relock(None, "time limit reached")
        await self._power_watch(now)

    async def _power_watch(self, now: datetime) -> None:
        """Ventilator power: alert while the battery still has time, so someone can fix it."""
        settings = self.settings()
        if not settings.home.watch_power or not self.home.has_power:
            return
        if self._power_checked_at and (now - self._power_checked_at).total_seconds() < POWER_CHECK_EVERY_S:
            return
        self._power_checked_at = now
        snapshot = await self.home.snapshot()
        self._home_cache = snapshot
        mains = snapshot["power"]["mains"]
        minutes = snapshot["power"]["battery_minutes"]
        state: dict[str, Any] = self.db.get_state(POWER_KEY, {}) or {}
        name = self._person()
        threshold = settings.home.power_critical_minutes
        if mains is False:
            critical = minutes is None or minutes < threshold
            detail = (
                f"The ventilator is running on its battery: about {int(minutes)} minutes left."
                if minutes is not None
                else "There is no battery reading, so the ventilator may stop at any moment."
            )
            if not state.get("outage_since"):
                open_alert = self._open_alert()
                state = {"outage_since": iso(now), "critical": critical}
                if open_alert:
                    state["alert_id"] = open_alert["id"]
                    self._event(open_alert["id"], "power_lost", "system", f"{name}'s ventilator lost mains power. {detail}")
                    self._update_alert(open_alert["id"], detail=detail)
                    if not open_alert.get("situation"):
                        self._update_alert(open_alert["id"], situation="equipment")
                    await self._update_contacts(open_alert, f"{name}'s ventilator lost mains power. {detail}")
                    if critical:
                        await self._make_critical(open_alert, now, f"{name}'s ventilator lost mains power. ")
                else:
                    alert, _ = await self._create(
                        "power_lost", "device", situation="equipment", urgency="critical" if critical else "urgent", detail=detail
                    )
                    state["alert_id"] = alert["id"]
            elif not state.get("critical") and critical:
                state["critical"] = True
                alert_row = self._alert_row(state.get("alert_id", ""))
                if alert_row and alert_row["status"] in OPEN:
                    self._update_alert(alert_row["id"], detail=detail)
                    self._event(
                        alert_row["id"], "power_low", "system", f"Ventilator battery is below {threshold} minutes. {detail}"
                    )
                    await self._update_contacts(alert_row, f"the ventilator battery is below {threshold} minutes. {detail}")
                    await self._make_critical(alert_row, now, f"Ventilator battery below {threshold} minutes. ")
            self.db.set_state(POWER_KEY, state)
        elif mains is True and state.get("outage_since"):
            alert_row = self._alert_row(state.get("alert_id", ""))
            if alert_row and alert_row["status"] in OPEN:
                self._event(
                    alert_row["id"],
                    "power_back",
                    "system",
                    f"Mains power is back at the ventilator. Someone should still check on {name}.",
                )
                self._update_alert(alert_row["id"], detail="Mains power came back.")
                await self._update_contacts(alert_row, "mains power is back at the ventilator.")
            self.db.set_state(POWER_KEY, {})

    async def _make_critical(self, alert: dict[str, Any], now: datetime, context: str) -> None:
        fresh = self._alert_row(alert["id"])
        if not fresh or fresh.get("urgency") == "critical":
            return
        self._update_alert(fresh["id"], urgency="critical", critical_since=iso(now))
        fresh = self._alert_row(fresh["id"])
        assert fresh is not None
        if fresh["status"] == "active":
            await self._everyone_now(fresh, now, context)

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
            await self._dispatch_watch(now)
            await self._watch(now)
            await self._home_watch(now)

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

    async def network_back(self) -> list[dict[str, Any]]:
        """The network is back after an outage: alerts that couldn't get out are sent again now.

        Only to contacts this alert already tried and never reached by text (simulated phones don't need the
        network); people not tried yet are still reached by the normal escalation. Their next escalation is moved
        back if needed, so they get a full answer window.
        """
        sent: list[dict[str, Any]] = []
        if not self.channels.twilio_configured:
            return sent
        async with self.lock:
            now = self.now()
            settings = self.settings()
            for row in self.db.query("SELECT * FROM lifeline_alerts WHERE status = 'active' AND local_only = 0"):
                alert = dict(row)
                alerts = [n for n in self._notifications(alert["id"]) if n["purpose"] == "alert"]
                reached = {n["contact_id"] for n in alerts if n["status"] != "failed"}
                missed = {n["contact_id"] for n in alerts if n["status"] == "failed" and n["channel"] != "demo"}
                targets = [c for c in settings.enabled_contacts() if c.id in missed - reached and c.channel != "demo"]
                if not targets:
                    continue
                self._event(
                    alert["id"], "network_back", "system", f"The network is back. Sending the alert again to {_names(targets)}."
                )
                due = parse(alert["next_escalation_at"])
                window = now + timedelta(seconds=settings.ack_timeout_s)
                if due is None or due < window:
                    self._update_alert(alert["id"], next_escalation_at=iso(window))
                fresh = self._alert_row(alert["id"]) or alert
                sent += await self._notify(
                    fresh,
                    targets,
                    purpose="alert",
                    level=fresh["level"],
                    cycle=fresh["cycle"],
                    context="The network was down, so this alert is late. ",
                )
        return sent

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
        settings = self.settings()
        questions = [
            dict(r)
            for r in self.db.query("SELECT * FROM lifeline_questions WHERE alert_id = ? ORDER BY asked_at, rowid", (alert_id,))
        ]
        key = plan_key(alert.get("situation"))
        done = {
            r["step"]: dict(r)
            for r in self.db.query("SELECT * FROM lifeline_steps WHERE alert_id = ? AND plan = ?", (alert_id, key))
        }
        steps = [
            {
                "index": i,
                "key": f"{key}:{i}",
                "label": label,
                "done_by": done[i]["done_by"] if i in done else None,
                "done_at": done[i]["done_at"] if i in done else None,
            }
            for i, label in enumerate(self._plan_steps(key))
        ]
        dispatch_rows = self._dispatch_rows(alert_id)
        dispatch = self._dispatch_view(dispatch_rows[-1]) if dispatch_rows else None
        arrivals = [
            {"contact_id": n["contact_id"], "contact_name": n["contact_name"], "arrived_at": n["arrived_at"]}
            for n in notifications
            if n.get("arrived_at")
        ]
        times = {q["id"]: clock(parse(q["answered_at"])) for q in questions if q["answered_at"]}
        times.update({str(st["key"]): clock(parse(str(st["done_at"]))) for st in steps if st["done_at"]})
        summary = handoff(
            name=self._person(),
            what=self._what(alert),
            situation=alert.get("situation"),
            detail=alert.get("detail"),
            card=settings.responder.model_dump(),
            questions=questions,
            steps=steps,
            dispatch=dispatch,
            times=times,
        )
        home_state = self._home_state()
        return {
            **alert,
            "is_test": bool(alert["is_test"]),
            "local_only": bool(alert["local_only"]),
            "what": self._what(alert),
            "situation_label": situation_label(alert.get("situation")),
            "notifications": public,
            "events": events,
            "waiting_on": waiting if alert["status"] == "active" else [],
            "metrics": self._metrics(alert, notifications),
            "questions": questions,
            "pending_question": next((q for q in questions if not q["answer"]), None),
            "plan": {
                "key": key,
                "label": situation_label(alert.get("situation")) if key != "general" else "First steps",
                "steps": steps,
            },
            "plans_note": settings.plans_note,
            "dispatch": dispatch,
            "arrivals": arrivals,
            "door_unlocked_for": home_state.get("for") if home_state.get("alert_id") == alert_id else None,
            "door_relocks_at": home_state.get("relock_at") if home_state.get("alert_id") == alert_id else None,
            "handoff": [{"label": label, "text": text} for label, text in summary],
        }

    def _dispatch_view(self, row: dict[str, Any]) -> dict[str, Any]:
        sim = " (simulated)" if row["simulated"] else ""
        at = clock(parse(row["requested_at"]))
        summary = {
            "requested": f"Requested from {row['provider']}{sim} at {at}."
            + (f" Reference {row['provider_ref']}." if row["provider_ref"] else ""),
            "accepted": row["note"] or f"Confirmed by {row['provider']}{sim}.",
            "failed": f"Could not be requested: {row['error']}",
            "cancelled": f"Request cancelled (it was made at {at}).",
            "test_skipped": "Test alert: emergency services were not contacted.",
            "not_allowed": "Not requested: AGENCY isn't allowed to request emergency services.",
        }.get(row["status"], row["status"])
        return {
            "id": row["id"],
            "status": row["status"],
            "provider": row["provider"],
            "simulated": bool(row["simulated"]),
            "reason": row["reason"],
            "requested_by": row["requested_by"],
            "provider_ref": row["provider_ref"],
            "error": row["error"],
            "note": row["note"],
            "requested_at": row["requested_at"],
            "active": row["status"] in ACTIVE_DISPATCH,
            "summary": summary,
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
        if s.dispatch.consent:
            problem = self.dispatch.ready_problem(self._dispatch_info())
            if problem:
                issues.append(problem)
        net = self.network.snapshot() if self.network is not None else None
        if net and net["state"] in {"offline", "critical"}:
            where = " (Cisco sentinel)" if net["source"] == "cisco" else ""
            issues.append(
                f"The network is {net['state']}{where}, so alerts to people can't be sent right now. The alarm on this "
                "computer still works, and AGENCY sends waiting alerts as soon as the network is back."
            )
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
            "network": self.network.snapshot() if self.network is not None else None,
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
            "rescue": {
                "situations": [{"key": k, **v} for k, v in SITUATIONS.items()],
                "questions": [{"key": k, "text": v} for k, v in PRESET_QUESTIONS.items()],
            },
            "dispatch": {
                "provider": self.dispatch.name,
                "simulated": self.dispatch.simulated,
                "sandbox": bool(getattr(self.dispatch, "sandbox", False)),
                "ready": s.dispatch.consent and not self.dispatch.ready_problem(self._dispatch_info()),
            },
            "home": {
                "provider": self.home.name,
                "simulated": self.home.simulated,
                "has_lock": self.home.has_lock,
                "has_lights": self.home.has_lights,
                "has_power": self.home.has_power,
                "state": self._home_cache,
            },
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
        dispatched = self.db.query_one(
            "SELECT COUNT(DISTINCT alert_id) AS n FROM lifeline_dispatch WHERE status IN ('requested', 'accepted', 'cancelled')"
        )
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
                k: sum(1 for a in rows if a["kind"] == k)
                for k in ("help", "watchdog", "checkin_missed", "signal_unavailable", "power_lost")
            },
            "emergency_services_requested": dispatched["n"] if dispatched else 0,
        }
