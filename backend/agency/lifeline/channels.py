"""How Lifeline reaches people.

- ``demo``: a simulated phone. The message is stored and shown on the "Simulated phones"
  screen; the response link is real and works from any device that can reach the
  coordinator. Nobody outside the demo is contacted.
- ``sms`` / ``sms_call``: real text messages (and, for ``sms_call``, a phone call that reads
  the alert aloud to wake someone) through Twilio, only when TWILIO_* settings are present.

A channel reports what it actually knows. "sent" means the provider accepted the message;
only a person pressing "I'm on my way" counts as help confirmed.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from xml.sax.saxutils import escape

from ..services.common import Faults
from .models import Contact

log = logging.getLogger("agency.lifeline.channels")


@dataclass(frozen=True)
class Delivery:
    status: str  # "delivered" (simulated phone), "sent" (accepted by provider) or "failed"
    simulated: bool
    provider_ref: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class Outgoing:
    contact: Contact
    body: str
    voice_text: str
    purpose: str  # "alert" | "stand_down" | "all_clear" | "update" | "daily" (a non-urgent request: text only)
    primary: bool  # contact belongs to the first escalation level


class DemoChannel:
    name = "demo"

    def __init__(self, faults: Faults) -> None:
        self.faults = faults

    async def send(self, msg: Outgoing) -> Delivery:
        if msg.purpose == "alert" and msg.primary and self.faults.snapshot().get("lifeline_primary_unreachable"):
            return Delivery(status="failed", simulated=True, error="Phone unreachable (presenter fault)")
        return Delivery(status="delivered", simulated=True, provider_ref="simulated")


Transport = Callable[[str, dict[str, str], str], tuple[int, dict[str, Any]]]


def _urllib_transport(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=data, method="POST")  # noqa: S310 - fixed https Twilio API URL
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read() or b"{}")
        except json.JSONDecodeError:
            body = {}
        return exc.code, body


class TwilioChannel:
    """Real SMS (and optional voice call) through Twilio's REST API."""

    name = "twilio"
    api = "https://api.twilio.com/2010-04-01"

    def __init__(self, account_sid: str, auth_token: str, from_number: str, transport: Transport | None = None) -> None:
        self.account_sid = account_sid
        self.from_number = from_number
        self._auth = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
        self.transport = transport or _urllib_transport

    @classmethod
    def from_env(cls) -> TwilioChannel | None:
        sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
        token = os.environ.get("TWILIO_AUTH_TOKEN", "")
        sender = os.environ.get("TWILIO_FROM_NUMBER", "")
        if sid and token and sender:
            return cls(sid, token, sender)
        return None

    async def _post(self, resource: str, form: dict[str, str]) -> tuple[int, dict[str, Any]]:
        url = f"{self.api}/Accounts/{self.account_sid}/{resource}.json"
        try:
            return await asyncio.to_thread(self.transport, url, form, self._auth)
        except (OSError, ValueError) as exc:  # network errors, timeouts
            return 0, {"message": f"network error: {type(exc).__name__}"}

    async def send(self, msg: Outgoing) -> Delivery:
        to = msg.contact.address.replace(" ", "")
        status, body = await self._post("Messages", {"To": to, "From": self.from_number, "Body": msg.body})
        if status not in (200, 201):
            error = str(body.get("message") or f"HTTP {status}")[:200]
            log.warning("Twilio SMS to %s failed: %s", msg.contact.id, error)
            return Delivery(status="failed", simulated=False, error=f"Text message failed: {error}")
        ref = str(body.get("sid", ""))
        if msg.contact.channel == "sms_call" and msg.purpose == "alert":
            said = escape(msg.voice_text)
            twiml = f'<Response><Say>{said}</Say><Pause length="1"/><Say>{said}</Say></Response>'
            call_status, call_body = await self._post("Calls", {"To": to, "From": self.from_number, "Twiml": twiml})
            if call_status in (200, 201):
                ref = f"{ref},{call_body.get('sid', '')}"
            else:
                log.warning("Twilio call to %s failed: %s", msg.contact.id, call_body.get("message"))
        return Delivery(status="sent", simulated=False, provider_ref=ref)


class ChannelRouter:
    def __init__(self, faults: Faults, twilio: TwilioChannel | None) -> None:
        self.demo = DemoChannel(faults)
        self.twilio = twilio

    @property
    def twilio_configured(self) -> bool:
        return self.twilio is not None

    async def send(self, msg: Outgoing) -> Delivery:
        if msg.contact.channel == "demo":
            return await self.demo.send(msg)
        if self.twilio is None:
            return Delivery(
                status="failed",
                simulated=False,
                error="Real text messages aren't configured on this coordinator (TWILIO_* settings).",
            )
        return await self.twilio.send(msg)
