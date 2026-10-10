"""Requesting emergency services: simulated only in this build.

AGENCY never places an automated call to 911: US rules bar autodialed or prerecorded calls to
emergency lines (47 CFR 64.1200(a)(1)(i)), and a recording can't answer a call-taker's questions.
The realistic route is a staffed dispatch centre whose people verify the emergency and contact
911 with the address.

This build only includes ``DemoDispatch``, a simulated dispatch centre: nothing real is ever
contacted. Connecting a real dispatch service is deliberately left out. It would put real
ambulances on the road, partly automatically, and that needs the person's and their care team's
decision, a contract with the provider, and testing with that provider, not a code change.
LIFELINE.md describes what a real provider would need to plug in here.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from .models import DispatchAddress


@dataclass(frozen=True)
class DispatchInfo:
    name: str
    phone: str  # E.164
    address: DispatchAddress
    entry: str
    pin: str
    contacts: list[tuple[str, str]] = field(default_factory=list)  # (name, E.164) for the dispatcher to call too


@dataclass(frozen=True)
class DispatchResult:
    status: str  # "requested" | "cancelled" | "failed"
    simulated: bool
    provider_ref: str | None = None
    error: str | None = None
    note: str | None = None


class DemoDispatch:
    """A simulated dispatch centre. It 'confirms' a few seconds after a request."""

    name = "Demo Emergency Dispatch"
    simulated = True
    sandbox = False
    accept_after_s = 6
    eta_min = 8

    def ready_problem(self, info: DispatchInfo) -> str | None:
        return None

    async def request(self, info: DispatchInfo) -> DispatchResult:
        return DispatchResult(
            status="requested",
            simulated=True,
            provider_ref=f"DED-{secrets.randbelow(9000) + 1000}",
            note="Simulated: no real emergency service is contacted.",
        )

    async def cancel(self, ref: str, pin: str) -> DispatchResult:
        return DispatchResult(status="cancelled", simulated=True, provider_ref=ref)


DispatchProvider = DemoDispatch
