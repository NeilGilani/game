"""Network awareness: how good is the connection right now, and who measured it.

Someone who can't move can't troubleshoot Wi-Fi, so AGENCY watches the network for them and adapts: the
Synapse layer (agency/synapse.py) budgets every AI request by it, and Lifeline says plainly when alerts can't get
out and tries again the moment the network is back.

Sources, in order:

1. **Cisco sentinel** from Synapse-Mesh (Ray's project, github.com/RayB-007/synapse-mesh): `GET /network` reports
   OPTIMAL, CONGESTED, CRITICAL or OFFLINE from Cisco IOS XE RESTCONF interface counters, the cloud kernel's
   round-trip time, or its own mock telemetry. Mock telemetry is labelled simulated.
2. **AGENCY's own check**: a HEAD request to the cloud model's host, timed. Only when a cloud model is configured.
3. **Presenter override** (demo controls only), always labelled simulated.

States: good, slow, critical, offline, unknown.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from .db import utcnow

log = logging.getLogger("agency.network")

STATES = ("good", "slow", "critical", "offline", "unknown")
CISCO = {"OPTIMAL": "good", "CONGESTED": "slow", "CRITICAL": "critical", "OFFLINE": "offline"}
TO_CISCO = {v: k for k, v in CISCO.items()}
SENTINEL_SOURCES = {
    "restconf": "Cisco IOS XE router (RESTCONF)",
    "cloud-rtt": "Cisco sentinel: cloud kernel round trip",
    "mock": "Cisco sentinel (mock telemetry)",
}

# AGENCY's own check: round trip to the cloud model's host (connection + TLS + response headers).
SLOW_MS = 800.0
CRITICAL_MS = 2000.0

DESCRIPTIONS = {
    "good": "The network is working normally.",
    "slow": "The network is slow. AGENCY uses the cloud model more lightly.",
    "critical": "The network is barely working. AGENCY uses its built-in plans and doesn't wait for the cloud.",
    "offline": "The network is down. AGENCY uses its built-in plans; Lifeline alerts can't be sent until it's back.",
    "unknown": "Network watching isn't set up.",
}


def classify_rtt(ms: float) -> str:
    if ms >= CRITICAL_MS:
        return "critical"
    if ms >= SLOW_MS:
        return "slow"
    return "good"


@dataclass
class NetworkMonitor:
    synapse_url: str | None = None
    probe_url: str | None = None
    interval_s: float = 2.0
    client: Any = None
    state: str = "unknown"
    source: str = "none"
    detail: str = ""
    latency_ms: float | None = None
    simulated: bool = False
    at: str | None = None
    since: str | None = None
    demo: str | None = None
    listeners: list[Callable[[str, str], None]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.synapse_url:
            self.synapse_url = self.synapse_url.rstrip("/")
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0), follow_redirects=False)

    @property
    def configured(self) -> bool:
        return bool(self.synapse_url or self.probe_url)

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "source": self.source,
            "detail": self.detail,
            "latency_ms": self.latency_ms,
            "simulated": self.simulated,
            "at": self.at,
            "since": self.since,
            "description": DESCRIPTIONS.get(self.state, ""),
        }

    def on_change(self, listener: Callable[[str, str], None]) -> None:
        """listener(old_state, new_state), called on every state change."""
        self.listeners.append(listener)

    def _set(self, state: str, source: str, detail: str, latency_ms: float | None = None, simulated: bool = False) -> None:
        old = self.state
        self.state, self.source, self.detail = state, source, detail[:200]
        self.latency_ms = round(latency_ms, 1) if latency_ms is not None else None
        self.simulated = simulated
        self.at = utcnow()
        if state != old:
            self.since = self.at
            log.info("network %s -> %s (%s: %s)", old, state, source, detail)
            for listener in list(self.listeners):
                try:
                    listener(old, state)
                except Exception:  # a listener must never stop the monitor
                    log.exception("network listener failed")

    async def set_demo(self, state: str | None) -> dict[str, Any]:
        """Presenter override. Also moves Synapse-Mesh's mock telemetry, so both screens agree."""
        if state is not None and state not in CISCO.values():
            raise ValueError(f"unknown network state {state!r}")
        self.demo = state
        if self.synapse_url and state is not None:
            try:
                await self.client.post(f"{self.synapse_url}/network/mock", json={"state": TO_CISCO[state]})
            except (httpx.HTTPError, OSError):
                pass  # Synapse-Mesh in live mode or not running: AGENCY's override still applies
        await self.poll()
        return self.snapshot()

    async def poll(self) -> None:
        if self.demo:
            self._set(self.demo, "demo", "Presenter control", simulated=True)
            return
        if self.synapse_url and await self._poll_synapse():
            return
        if self.probe_url:
            await self._probe()
            return
        if self.synapse_url:
            self._set("unknown", "none", f"Synapse-Mesh isn't reachable at {self.synapse_url}")
            return
        self._set("unknown", "none", "No network source is configured")

    async def _poll_synapse(self) -> bool:
        try:
            response = await self.client.get(f"{self.synapse_url}/network")
            data = response.json() if response.status_code == 200 else None
        except (httpx.HTTPError, OSError, ValueError):
            return False
        if not isinstance(data, dict):
            return False
        state = CISCO.get(str(data.get("state") or "").upper())
        if state is None:
            return False
        source = str(data.get("source") or "")
        where = SENTINEL_SOURCES.get(source, "Cisco sentinel")
        extra = str(data.get("detail") or "").strip()
        latency = data.get("latency_ms")
        self._set(
            state,
            "cisco",
            f"{where}: {extra}" if extra else where,
            float(latency) if isinstance(latency, int | float) else None,
            simulated=source == "mock",
        )
        return True

    async def _probe(self) -> None:
        start = time.perf_counter()
        try:
            await self.client.head(self.probe_url)
        except httpx.TimeoutException:
            self._set("offline", "probe", "The cloud model's host didn't answer in time")
            return
        except (httpx.HTTPError, OSError):
            self._set("offline", "probe", "Can't reach the cloud model's host")
            return
        ms = (time.perf_counter() - start) * 1000
        self._set(classify_rtt(ms), "probe", f"Round trip to the cloud model's host: {round(ms)} ms", ms)

    async def run(self) -> None:
        while True:
            try:
                await self.poll()
            except Exception:  # keep watching no matter what
                log.exception("network poll failed")
            await asyncio.sleep(self.interval_s)


def monitor_from_env(env: dict[str, str], cloud_configured: bool) -> NetworkMonitor:
    """Synapse-Mesh's Cisco sentinel when configured; otherwise AGENCY's own check when a cloud model is used."""
    synapse = (env.get("AGENCY_SYNAPSE_URL") or env.get("AGENCY_LOCAL_MODEL_URL") or "").strip() or None
    probe: str | None = None
    if (env.get("AGENCY_NETWORK_PROBE") or "1") != "0" and cloud_configured:
        probe = (env.get("AGENCY_NETWORK_PROBE_URL") or "").strip() or "https://generativelanguage.googleapis.com/"
    try:
        interval = max(1.0, float(env.get("AGENCY_NETWORK_INTERVAL_S") or 2.0))
    except ValueError:
        interval = 2.0
    return NetworkMonitor(synapse_url=synapse, probe_url=probe, interval_s=interval)
