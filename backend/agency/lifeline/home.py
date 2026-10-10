"""The home: letting helpers in, turning lights on, and watching the ventilator's power.

- ``DemoHome``: a simulated smart home for the demo (front door lock, hall light, and the
  ventilator's outlet with a backup battery). A presenter fault simulates a power cut.
- ``HomeAssistantHome``: a real home through Home Assistant's REST API, used only when
  HOMEASSISTANT_URL and HOMEASSISTANT_TOKEN are set. In this build it only *reads* the
  ventilator's power and turns lights on. It never unlocks a real door: that is a physical
  security decision for the person and their household, not something to switch on by default.

In the simulated home, unlocking the door only happens when the person has allowed it in
setup, only for an open alert, only for a contact who has said they are on the way (or for
emergency services, if separately allowed), and the door relocks by itself.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..db import Database, dumps, loads, utcnow
from ..services.common import Faults

log = logging.getLogger("agency.lifeline.home")

DEMO_BATTERY_MINUTES = 45.0


@dataclass(frozen=True)
class PowerState:
    mains: bool | None  # None: unknown (sensor unavailable)
    battery_minutes: float | None


@dataclass(frozen=True)
class HomeResult:
    ok: bool
    error: str | None = None


class DemoHome:
    name = "Demo Smart Home"
    simulated = True
    has_lock = True
    has_lights = True
    has_power = True

    def __init__(self, db: Database, faults: Faults, now: Callable[[], datetime]) -> None:
        self.db = db
        self.faults = faults
        self.now = now

    def _device(self, device_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM svc_home_devices WHERE id = ?", (device_id,))
        return {**dict(row), "attributes": loads(row["attributes"])} if row else None

    def _set(self, device_id: str, state: str, attributes: dict[str, Any] | None = None) -> None:
        current = self._device(device_id)
        attrs = attributes if attributes is not None else (current["attributes"] if current else {})
        self.db.execute(
            "UPDATE svc_home_devices SET state = ?, attributes = ?, updated_at = ? WHERE id = ?",
            (state, dumps(attrs), utcnow(), device_id),
        )

    async def unlock(self) -> HomeResult:
        self._set("front_door", "unlocked")
        return HomeResult(ok=True)

    async def lock(self) -> HomeResult:
        self._set("front_door", "locked")
        return HomeResult(ok=True)

    async def lights_on(self) -> HomeResult:
        self._set("hall_light", "on")
        return HomeResult(ok=True)

    async def door_state(self) -> str | None:
        device = self._device("front_door")
        return device["state"] if device else None

    async def power(self) -> PowerState:
        device = self._device("ventilator_power")
        if not device:
            return PowerState(mains=None, battery_minutes=None)
        attrs = dict(device["attributes"])
        cut = bool(self.faults.snapshot().get("lifeline_power_cut"))
        now = self.now()
        if cut and device["state"] != "battery":
            attrs["since"] = now.isoformat()
            self._set("ventilator_power", "battery", attrs)
            device["state"] = "battery"
        elif not cut and device["state"] != "mains":
            attrs.pop("since", None)
            self._set("ventilator_power", "mains", attrs)
            device["state"] = "mains"
        if device["state"] == "mains":
            return PowerState(mains=True, battery_minutes=float(attrs.get("battery_full_minutes", DEMO_BATTERY_MINUTES)))
        since = datetime.fromisoformat(attrs["since"]) if attrs.get("since") else now
        used = (now - since).total_seconds() / 60
        left = max(0.0, float(attrs.get("battery_full_minutes", DEMO_BATTERY_MINUTES)) - used)
        return PowerState(mains=False, battery_minutes=round(left, 1))

    async def snapshot(self) -> dict[str, Any]:
        power = await self.power()
        lights = self._device("hall_light")
        return {
            "provider": self.name,
            "simulated": True,
            "door": await self.door_state(),
            "lights": lights["state"] if lights else None,
            "power": {"mains": power.mains, "battery_minutes": power.battery_minutes},
        }


HttpTransport = Callable[[str, str, dict[str, str], Any], tuple[int, Any]]


def _http(method: str, url: str, headers: dict[str, str], body: Any) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)  # noqa: S310 - configured Home Assistant URL
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:  # noqa: S310
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        return exc.code, None


class HomeAssistantHome:
    """Home Assistant REST API: GET /api/states/<entity>, POST /api/services/<domain>/<service>."""

    name = "Home Assistant"
    simulated = False

    has_lock = False  # never unlocks a real door in this build

    def __init__(
        self,
        url: str,
        token: str,
        *,
        lights_entity: str = "",
        power_entity: str = "",
        battery_entity: str = "",
        transport: HttpTransport | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self._token = token
        self.lights_entity = lights_entity
        self.power_entity = power_entity
        self.battery_entity = battery_entity
        self.transport = transport or _http

    @classmethod
    def from_env(cls) -> HomeAssistantHome | None:
        url = os.environ.get("HOMEASSISTANT_URL", "")
        token = os.environ.get("HOMEASSISTANT_TOKEN", "")
        if not (url and token):
            return None
        return cls(
            url,
            token,
            lights_entity=os.environ.get("AGENCY_HA_LIGHTS", ""),
            power_entity=os.environ.get("AGENCY_HA_VENTILATOR_POWER", ""),
            battery_entity=os.environ.get("AGENCY_HA_VENTILATOR_BATTERY", ""),
        )

    @property
    def has_lights(self) -> bool:
        return bool(self.lights_entity)

    @property
    def has_power(self) -> bool:
        return bool(self.power_entity)

    async def _call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        headers = {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}
        try:
            return await asyncio.to_thread(self.transport, method, f"{self.url}{path}", headers, body)
        except (OSError, ValueError) as exc:
            log.warning("Home Assistant unreachable: %s", type(exc).__name__)
            return 0, None

    async def _service(self, domain: str, service: str, entity: str) -> HomeResult:
        if not entity:
            return HomeResult(ok=False, error="Not configured.")
        status, _ = await self._call("POST", f"/api/services/{domain}/{service}", {"entity_id": entity})
        if status != 200:
            return HomeResult(ok=False, error=f"Home Assistant answered {status or 'nothing (unreachable)'}.")
        return HomeResult(ok=True)

    async def _state(self, entity: str) -> str | None:
        if not entity:
            return None
        status, data = await self._call("GET", f"/api/states/{entity}")
        if status != 200 or not isinstance(data, dict):
            return None
        state = data.get("state")
        return str(state) if state is not None else None

    async def unlock(self) -> HomeResult:
        return HomeResult(ok=False, error="Unlocking a real door isn't enabled in this build.")

    async def lock(self) -> HomeResult:
        return HomeResult(ok=False, error="Controlling a real door lock isn't enabled in this build.")

    async def lights_on(self) -> HomeResult:
        return await self._service("light", "turn_on", self.lights_entity)

    async def door_state(self) -> str | None:
        return None

    async def power(self) -> PowerState:
        state = await self._state(self.power_entity)
        mains = True if state == "on" else False if state == "off" else None
        battery: float | None = None
        raw = await self._state(self.battery_entity)
        if raw is not None:
            try:
                battery = float(raw)
            except ValueError:
                battery = None
        return PowerState(mains=mains, battery_minutes=battery)

    async def snapshot(self) -> dict[str, Any]:
        power = await self.power() if self.has_power else PowerState(None, None)
        return {
            "provider": self.name,
            "simulated": False,
            "door": None,
            "lights": await self._state(self.lights_entity) if self.has_lights else None,
            "power": {"mains": power.mains, "battery_minutes": power.battery_minutes},
        }


HomeProvider = DemoHome | HomeAssistantHome


def seed_demo_home(db: Database) -> None:
    for device_id, kind, name, state, attrs in (
        ("front_door", "lock", "Front door", "locked", {}),
        ("hall_light", "light", "Hall light", "off", {}),
        ("ventilator_power", "power", "Ventilator outlet", "mains", {"battery_full_minutes": DEMO_BATTERY_MINUTES}),
    ):
        db.execute(
            "INSERT INTO svc_home_devices(id, kind, name, state, attributes, updated_at) VALUES (?,?,?,?,?,?)",
            (device_id, kind, name, state, dumps(attrs), utcnow()),
        )
