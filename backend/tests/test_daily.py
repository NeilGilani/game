"""Daily living's "tell my carer" (agency/daily): off by default, the person approves the exact words, one
carer, once, through Lifeline's channels (a simulated phone, or a real text only with Twilio), never a call,
never an alert, and limited."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agency.daily.service import DUPLICATE_S, LIMIT_COUNT, TICKET_TTL_S
from agency.lifeline.channels import TwilioChannel
from conftest import make_client


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def client(tmp_path: Path, clock: Clock) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        c.app.state.daily_clock = clock  # type: ignore[attr-defined]
        yield c


def turn_on(client: TestClient, **extra: Any) -> dict[str, Any]:
    r = client.put("/api/daily/settings", json={"notify_enabled": True, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def prepare(client: TestClient, text: str = "I'm cold. Could you bring a blanket?", **extra: Any) -> dict[str, Any]:
    r = client.post("/api/daily/prepare", json={"kind": "help", "text": text, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_off_by_default_and_nothing_can_be_prepared(client: TestClient) -> None:
    view = client.get("/api/daily/settings").json()
    assert view["settings"] == {"notify_enabled": False, "carer_id": None, "enabled_at": None}
    assert view["carer"]["id"] == "jordan"  # who it would go to, shown before turning it on
    r = client.post("/api/daily/prepare", json={"kind": "help", "text": "I'm cold"})
    assert r.status_code == 409
    assert "off" in r.json()["detail"]
    assert client.get("/api/daily/messages").json()["messages"] == []


def test_turning_on_records_when_and_lists_lifeline_contacts(client: TestClient) -> None:
    view = turn_on(client)
    assert view["settings"]["enabled_at"]
    assert [c["id"] for c in view["contacts"]] == ["jordan", "morgan", "monitoring"]
    assert view["carer"]["simulated"] is True
    again = turn_on(client)
    assert again["settings"]["enabled_at"] == view["settings"]["enabled_at"]
    off = client.put("/api/daily/settings", json={"notify_enabled": False}).json()
    assert off["settings"]["enabled_at"] is None


def test_carer_must_be_a_lifeline_contact(client: TestClient) -> None:
    r = client.put("/api/daily/settings", json={"notify_enabled": True, "carer_id": "stranger"})
    assert r.status_code == 409
    assert turn_on(client, carer_id="morgan")["carer"]["id"] == "morgan"
    assert client.put("/api/daily/settings", json={"notify_enabled": True, "extra": 1}).status_code == 422


def test_prepare_shows_the_exact_words_and_send_reaches_the_simulated_phone_once(client: TestClient) -> None:
    turn_on(client)
    p = prepare(client)
    assert p["to"]["name"] == "Jordan"
    assert p["to"]["simulated"] is True
    assert p["body"] == "Riley (not urgent): I'm cold. Could you bring a blanket?\nSent from AGENCY. Nothing else will follow."
    sent = client.post("/api/daily/send", json={"ticket": p["ticket"]}).json()
    assert sent["status"] == "delivered"
    assert sent["simulated"] is True
    again = client.post("/api/daily/send", json={"ticket": p["ticket"]})
    assert again.status_code == 409, "a ticket is used once"
    messages = client.get("/api/daily/messages").json()["messages"]
    assert len(messages) == 1
    assert messages[0]["body"] == p["body"]
    assert messages[0]["kind"] == "help"


def test_never_an_alert(client: TestClient) -> None:
    turn_on(client)
    p = prepare(client)
    client.post("/api/daily/send", json={"ticket": p["ticket"]})
    status = client.get("/api/lifeline/status").json()
    assert status["open_alert"] is None
    assert status["recent"] == []
    assert client.get("/api/lifeline/alerts").json() == []
    assert client.get("/api/lifeline/outbox").json()["messages"] == []


def test_words_are_cleaned_and_limited(client: TestClient) -> None:
    turn_on(client)
    p = prepare(client, text="Turn\nme\x07  please")
    assert "Turn me please" in p["body"]
    assert client.post("/api/daily/prepare", json={"kind": "help", "text": "x" * 161}).status_code == 422
    assert client.post("/api/daily/prepare", json={"kind": "emergency", "text": "help"}).status_code == 422
    r = client.post("/api/daily/prepare", json={"kind": "help", "text": "\x07\x07"})
    assert r.status_code == 409


def test_a_ticket_runs_out_and_cancel_forgets_it(client: TestClient, clock: Clock) -> None:
    turn_on(client)
    p = prepare(client)
    clock.t += TICKET_TTL_S + 1
    assert client.post("/api/daily/send", json={"ticket": p["ticket"]}).status_code == 409
    q = prepare(client)
    client.post("/api/daily/cancel", json={"ticket": q["ticket"]})
    assert client.post("/api/daily/send", json={"ticket": q["ticket"]}).status_code == 409
    assert client.get("/api/daily/messages").json()["messages"] == []


def test_turning_off_drops_waiting_requests(client: TestClient) -> None:
    turn_on(client)
    p = prepare(client)
    client.put("/api/daily/settings", json={"notify_enabled": False})
    r = client.post("/api/daily/send", json={"ticket": p["ticket"]})
    assert r.status_code == 409
    assert client.get("/api/daily/messages").json()["messages"] == []


def test_the_same_words_are_not_sent_twice_in_a_minute(client: TestClient, clock: Clock) -> None:
    turn_on(client)
    client.post("/api/daily/send", json={"ticket": prepare(client)["ticket"]})
    r = client.post("/api/daily/send", json={"ticket": prepare(client)["ticket"]})
    assert r.status_code == 409
    assert "less than a minute ago" in r.json()["detail"]
    clock.t += DUPLICATE_S + 1
    assert client.post("/api/daily/send", json={"ticket": prepare(client)["ticket"]}).status_code == 200


def test_rate_limited(client: TestClient, clock: Clock) -> None:
    turn_on(client)
    for i in range(LIMIT_COUNT):
        r = client.post("/api/daily/send", json={"ticket": prepare(client, text=f"Request {i}")["ticket"]})
        assert r.status_code == 200
    r = client.post("/api/daily/send", json={"ticket": prepare(client, text="One more")["ticket"]})
    assert r.status_code == 409
    assert "a lot of requests" in r.json()["detail"]
    clock.t += 11 * 60
    assert client.post("/api/daily/send", json={"ticket": prepare(client, text="Later")["ticket"]}).status_code == 200


def real_contact(client: TestClient, channel: str = "sms_call") -> None:
    settings = client.get("/api/lifeline/settings").json()
    settings["contacts"] = [{"id": "alex", "name": "Alex", "channel": channel, "address": "+14155550100"}]
    assert client.put("/api/lifeline/settings", json=settings).status_code == 200


def test_a_real_contact_needs_twilio(client: TestClient) -> None:
    real_contact(client)
    view = turn_on(client)
    assert view["carer"]["simulated"] is False
    r = client.post("/api/daily/prepare", json={"kind": "help", "text": "I'm cold"})
    assert r.status_code == 409
    assert "aren't set up" in r.json()["detail"]


def test_a_real_contact_gets_one_text_and_never_a_call(client: TestClient) -> None:
    calls: list[str] = []

    def transport(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
        calls.append(url.rsplit("/", 1)[-1])
        return 201, {"sid": "SM1"}

    client.app.state.agency.lifeline.channels.twilio = TwilioChannel("AC1", "t", "+15005550006", transport=transport)  # type: ignore[attr-defined]
    real_contact(client, "sms_call")
    turn_on(client)
    p = prepare(client)
    assert "text message" in p["to"]["how"]
    sent = client.post("/api/daily/send", json={"ticket": p["ticket"]}).json()
    assert sent["status"] == "sent"
    assert sent["simulated"] is False
    assert calls == ["Messages.json"], "a text only: no phone call for a non-urgent request"


def test_a_removed_carer_gets_nothing(client: TestClient) -> None:
    turn_on(client, carer_id="morgan")
    p = prepare(client)
    settings = client.get("/api/lifeline/settings").json()
    settings["contacts"] = [c for c in settings["contacts"] if c["id"] != "morgan"]
    client.put("/api/lifeline/settings", json=settings)
    r = client.post("/api/daily/send", json={"ticket": p["ticket"]})
    assert r.status_code == 409
    assert "isn't one of your contacts" in r.json()["detail"]


def test_needs_the_coordinator_token_when_one_is_set(tmp_path: Path) -> None:
    with make_client(tmp_path, token="s3cret") as c:
        assert c.get("/api/daily/settings").status_code == 401
        assert c.put("/api/daily/settings", json={"notify_enabled": True}).status_code == 401
        ok = c.get("/api/daily/settings", headers={"X-Agency-Token": "s3cret"})
        assert ok.status_code == 200
