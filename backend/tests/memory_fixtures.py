"""Shared helpers for the memory tests: a coordinator with the memory router and a fake clock."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from agency.db import Database
from agency.memory import FakeClock, MemoryService
from agency.memory.models import MemorySettings, SelectionEventIn
from conftest import make_client

TZ = ZoneInfo("America/New_York")
# Friday 9 October 2026, 7 pm in New York.
FRIDAY_EVENING = datetime(2026, 10, 9, 19, 0, tzinfo=TZ)


def memory_client(tmp_path: Path, clock: FakeClock, **state: Any) -> TestClient:
    client = make_client(tmp_path)
    app = client.app
    app.state.memory_clock = clock  # type: ignore[attr-defined]
    for key, value in state.items():
        setattr(app.state, key, value)  # type: ignore[attr-defined]
    return client


def make_service(tmp_path: Path, clock: FakeClock, **kwargs: Any) -> MemoryService:
    db = Database(tmp_path / "memory.db")
    db.migrate()
    svc = MemoryService(db, clock, **kwargs)
    svc.save_settings(MemorySettings(timezone="America/New_York"))
    return svc


def choose(svc: MemoryService, path: list[str], surface: str = "food", outcome: str = "chosen", **attributes: str) -> Any:
    return svc.record(SelectionEventIn(path=path, surface=surface, outcome=outcome, attributes=attributes))  # type: ignore[arg-type]


def weeks_back(clock: FakeClock, start: datetime, weeks: int) -> None:
    clock.set(start - timedelta(weeks=weeks))
