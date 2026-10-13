"""Ties the companion together for the coordinator: the service, the phone server and turning it on and off."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..db import Database
from ..lifeline.service import LifelineService
from .config import CompanionConfig, load_config
from .server import CompanionListener, Limits, build_phone_app
from .service import CompanionError, CompanionService


class CompanionRuntime:
    def __init__(
        self,
        db: Database,
        lifeline: LifelineService,
        state: Any,
        frontend_dist: Path | None,
        config: CompanionConfig | None = None,
    ) -> None:
        self.config = config or load_config()
        self.service = CompanionService(db, lifeline)
        self.limits = Limits()
        self.listener = CompanionListener(self.config)
        self.app = build_phone_app(state, self.service, self.config, frontend_dist, self.limits)

    async def on_startup(self) -> None:
        """Bring the phone server back after a restart if a helper had left caregiver phones on."""
        if self.config.listen and self.config.available and self.service.enabled():
            await self.listener.start(self.app)

    async def shutdown(self) -> None:
        await self.listener.stop()

    async def set_enabled(self, on: bool) -> None:
        listen = self.config.listen
        if on and not self.config.available:
            raise CompanionError("Caregiver phones are turned off on this coordinator (AGENCY_COMPANION=off).", 403)
        if on == self.service.enabled() and (not on or not listen or self.listener.listening):
            return
        self.service.set_enabled(on)
        self.limits.reset()
        if on and listen:
            if not await self.listener.start(self.app):
                self.service.set_enabled(False)
                raise CompanionError(self.listener.error or "The phone server couldn't start.", 503)
        elif not on:
            await self.listener.stop()

    def status(self) -> dict[str, Any]:
        enabled = self.service.enabled()
        pairing = self.service.pairing_open() if enabled else None
        return {
            "available": self.config.available,
            "enabled": enabled,
            "listening": self.listener.listening,
            "error": self.listener.error,
            "url": self.config.base_url() if enabled else None,
            "secure": self.config.tls,
            "pairing": {"expires_at": pairing["expires_at"]} if pairing else None,
            "devices": self.service.devices(),
            "waiting_for_person": [c for c in self.service.open_changes() if c["status"] == "waiting_person"],
        }
