from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agency.config import load_settings
from agency.main import create_app
from agency.reasoning.provider import DisabledProvider


def make_client(
    tmp_path: Path, *, provider: Any = None, token: str | None = None, db_name: str = "test.db", inline: bool = True
) -> TestClient:
    settings = load_settings(
        db_path=tmp_path / db_name,
        step_delay_ms=0,
        api_token=token,
        frontend_dist=None,
        demo_controls=True,
        lifeline_loop=False,
    )
    app = create_app(settings, provider=provider or DisabledProvider(), inline_runner=inline)
    return TestClient(app)


def tune(client: TestClient) -> None:
    engine = client.app.state.agency.engine  # type: ignore[attr-defined]
    engine.backoff_scale = 0.0
    engine.timeout_scale = 0.05


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        tune(c)
        yield c


REPAIR_GOAL_REQUEST = {"goal_type": "equipment_repair", "selections": {"issue": "battery"}}


def start_repair(client: TestClient, **selections: str) -> dict[str, Any]:
    body = {"goal_type": "equipment_repair", "selections": {"issue": "battery", **selections}}
    preview = client.post("/api/goals/interpret", json=body).json()
    assert preview["ready"], preview
    res = client.post("/api/cases", json={"goal": preview["goal"]})
    assert res.status_code == 201, res.text
    return res.json()


def step(case: dict[str, Any], step_id: str) -> dict[str, Any]:
    return next(s for s in case["steps"] if s["id"] == step_id)
