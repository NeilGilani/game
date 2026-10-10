"""The /api/memory/* routes from os/contracts/src/memory.ts, end to end over HTTP with a fake clock."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from memory_fixtures import FRIDAY_EVENING, memory_client

from agency.memory import FakeClock

DINNER = ["food", "delivery", "Thai Basil", "Pad thai (mild)"]


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(FRIDAY_EVENING)


@pytest.fixture
def client(tmp_path: Path, clock: FakeClock) -> Iterator[TestClient]:
    with memory_client(tmp_path, clock) as c:
        assert c.put("/api/memory/settings", json={"timezone": "America/New_York"}).status_code == 200
        yield c


def post_event(client: TestClient, path: list[str], surface: str = "food", outcome: str = "chosen", **extra: Any) -> Any:
    res = client.post("/api/memory/events", json={"path": path, "surface": surface, "outcome": outcome, **extra})
    assert res.status_code == 200, res.text
    return res.json()


def four_fridays(client: TestClient, clock: FakeClock) -> None:
    for weeks in (4, 3, 2, 1):
        clock.set(FRIDAY_EVENING - timedelta(weeks=weeks))
        post_event(client, DINNER, attributes={"restaurant": "Thai Basil", "spice": "mild"})
    clock.set(FRIDAY_EVENING)


def test_every_contract_endpoint(client: TestClient, clock: FakeClock) -> None:
    four_fridays(client, clock)

    suggestions = client.get("/api/memory/suggestions", params={"surface": "food", "limit": 6}).json()
    assert len(suggestions) == 1
    s = suggestions[0]
    assert set(s) >= {"nodeId", "path", "label", "score", "reason"}
    assert s["path"] == DINNER and 0 <= s["score"] <= 1
    assert s["reason"] == "You chose this 4 of your last 4 Friday evenings."
    assert s["task"]["selections"]["restaurant"] == "Thai Basil"

    usual = client.get("/api/memory/usual", params={"path": "food/delivery"}).json()
    assert usual["nodeId"] == s["nodeId"]
    assert client.get("/api/memory/usual", params={"path": "papers"}).json() is None
    assert client.get("/api/memory/usual", params=[("p", "food"), ("p", "delivery")]).json()["nodeId"] == s["nodeId"]

    tree = client.get("/api/memory/tree").json()
    assert {n["label"] for n in tree} == set(DINNER)
    node = next(n for n in tree if n["label"] == "Pad thai (mild)")
    assert set(node) >= {
        "id",
        "kind",
        "label",
        "parentId",
        "attributes",
        "pinned",
        "hidden",
        "sensitive",
        "createdAt",
        "updatedAt",
    }

    patched = client.patch(f"/api/memory/nodes/{node['id']}", json={"label": "Friday pad thai", "pinned": True})
    assert patched.status_code == 200 and patched.json()["label"] == "Friday pad thai" and patched.json()["pinned"]

    detail = client.get(f"/api/memory/nodes/{node['id']}").json()
    assert detail["timesChosen"] == 4 and detail["path"][-1] == "Friday pad thai"
    assert detail["reason"].startswith("You pinned this.")

    export = client.get("/api/memory/export")
    assert export.status_code == 200 and "attachment" in export.headers["content-disposition"]
    body = export.json()
    assert body["format"] == "agency-memory-export" and len(body["events"]) == 4
    assert body["events"][0]["path"][0] == "food"

    assert client.delete(f"/api/memory/nodes/{node['id']}").json() == {"forgotten": 1}
    assert client.get("/api/memory/tree").json() == []
    assert client.delete(f"/api/memory/nodes/{node['id']}").status_code == 404

    post_event(client, DINNER)
    assert client.post("/api/memory/forget-all").status_code == 422
    assert client.post("/api/memory/forget-all", json={"confirm": True}).status_code == 200
    assert client.get("/api/memory/tree").json() == []


def test_server_fills_the_time_and_validates_input(client: TestClient) -> None:
    post_event(client, ["talk", "Hello"], surface="talk")
    exported = client.get("/api/memory/export").json()
    assert exported["events"][0]["at"].startswith("2026-10-09T23:00:00")  # 7 pm New York, in UTC
    bad = [
        {"path": [], "surface": "food", "outcome": "chosen"},
        {"path": ["food"], "surface": "space", "outcome": "chosen"},
        {"path": ["food"], "surface": "food", "outcome": "maybe"},
        {"path": ["  "], "surface": "food", "outcome": "chosen"},
        {"path": ["x"] * 9, "surface": "food", "outcome": "chosen"},
    ]
    for body in bad:
        assert client.post("/api/memory/events", json=body).status_code == 422, body
    assert client.get("/api/memory/suggestions", params={"surface": "moon"}).status_code == 422
    assert client.get("/api/memory/usual").status_code == 422


def test_suggestions_for_every_surface(client: TestClient) -> None:
    samples = {
        "home": ["home", "Lights", "Living room lamp"],
        "food": DINNER,
        "call": ["call", "Jordan"],
        "talk": ["talk", "Thank you"],
        "keyboard": ["keyboard", "thanks"],
        "papers": ["papers", "Benefits letter"],
        "shopping": ["shopping", "groceries", "Oat milk"],
        "apps": ["apps", "Music"],
        "browse": ["browse", "YouTube"],
    }
    for surface, path in samples.items():
        post_event(client, path, surface=surface)
    for surface, path in samples.items():
        got = client.get("/api/memory/suggestions", params={"surface": surface}).json()
        assert path[-1] in [g["label"] for g in got], surface


def test_prefill_for_agent_choice_questions(client: TestClient, clock: FakeClock) -> None:
    four_fridays(client, clock)
    question = {
        "id": "q1",
        "prompt": "How spicy?",
        "options": [{"id": "mild", "label": "Mild", "image": "data:,"}, {"id": "hot", "label": "Hot"}],
    }
    res = client.post("/api/memory/prefill", json={"path": ["food", "delivery"], "question": question}).json()
    assert res["optionId"] == "mild" and res["reason"] == "You chose Mild 4 of your last 4 Friday evenings."
    none = client.post("/api/memory/prefill", json={"path": ["papers"], "question": question})
    assert none.status_code == 200 and none.json() is None


def test_onboarding_and_settings(client: TestClient) -> None:
    res = client.post(
        "/api/memory/onboarding",
        json={"answers": [{"path": ["call", "Jordan"], "surface": "call"}, {"path": DINNER, "surface": "food", "weekday": 4}]},
    )
    assert res.status_code == 200 and res.json()["stored"] == 2
    assert client.get("/api/memory/suggestions", params={"surface": "call"}).json()[0]["reason"] == (
        "You told AGENCY about this during setup."
    )
    settings = client.get("/api/memory/settings").json()
    assert settings["halfLifeDays"] == 30 and settings["privateMode"] is False
    assert client.put("/api/memory/settings", json={**settings, "halfLifeDays": 0}).status_code == 422
    assert client.put("/api/memory/settings", json={**settings, "timezone": "Mars/Olympus"}).status_code == 422
    overview = client.get("/api/memory/overview").json()
    assert overview["counts"]["events"] == 2 and overview["encryption"]["enabled"] is False


def test_router_respects_the_coordinator_token(tmp_path: Path, clock: FakeClock) -> None:
    from agency.memory import memory_router
    from conftest import make_client

    c = make_client(tmp_path, token="s3cret")
    c.app.include_router(memory_router())  # type: ignore[attr-defined]
    c.app.state.memory_clock = clock  # type: ignore[attr-defined]
    with c:
        assert c.get("/api/memory/tree").status_code == 401
        assert c.get("/api/memory/tree", headers={"X-Agency-Token": "s3cret"}).status_code == 200


def test_latency_of_suggestions_with_a_year_of_history(client: TestClient, clock: FakeClock) -> None:
    """Not a benchmark (see BENCHMARKS.md), just a guard against accidental slowness."""
    import time

    svc = client.app.state.memory  # type: ignore[attr-defined]
    from agency.memory.models import SelectionEventIn

    for day in range(1, 366):
        base = FRIDAY_EVENING - timedelta(days=day)
        for meal, back in (("Breakfast", 11), ("Lunch", 6), ("Dinner", 0)):
            clock.set(base - timedelta(hours=back))
            svc.record(SelectionEventIn(path=["food", meal, f"Option {day % 7}"], surface="food", outcome="chosen"))
    clock.set(FRIDAY_EVENING)
    start = time.perf_counter()
    res = client.get("/api/memory/suggestions", params={"surface": "food"})
    elapsed = time.perf_counter() - start
    assert res.status_code == 200 and res.json()
    assert elapsed < 1.0, elapsed
