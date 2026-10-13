"""My day: the schedule, care routines and non-urgent requests to a carer.

Requests go through Lifeline's channels but never through Lifeline's emergency path: no alert, no escalation,
no call. Time is driven by a fake clock.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agency.daily.service import DailyService
from agency.lifeline.channels import TwilioChannel
from conftest import make_client

DAY = "2026-10-12"


class Clock:
    def __init__(self) -> None:
        self.t = datetime(2026, 10, 12, 16, 0, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)


@dataclass
class D:
    client: TestClient
    clock: Clock

    @property
    def svc(self) -> DailyService:
        svc: DailyService = self.client.app.state.daily  # type: ignore[attr-defined]
        return svc

    def state(self) -> dict[str, Any]:
        res = self.client.get(f"/api/daily?day={DAY}")
        assert res.status_code == 200, res.text
        out: dict[str, Any] = res.json()
        return out

    def settings(self, **body: Any) -> dict[str, Any]:
        res = self.client.put("/api/daily/settings", json=body)
        assert res.status_code == 200, res.text
        out: dict[str, Any] = res.json()
        return out

    def ask(self, text: str, kind: str = "help") -> dict[str, Any]:
        res = self.client.post("/api/daily/requests", json={"kind": kind, "text": text})
        assert res.status_code == 200, res.text
        out: dict[str, Any] = res.json()
        return out

    def link(self) -> str:
        messages = self.client.get("/api/daily/outbox").json()["messages"]
        assert messages, "no message reached a simulated phone"
        link: str = messages[0]["link"]
        return link


@pytest.fixture
def d(tmp_path: Path) -> Iterator[D]:
    with make_client(tmp_path) as client:
        clock = Clock()
        client.get(f"/api/daily?day={DAY}")  # make the service
        client.app.state.daily.now = clock  # type: ignore[attr-defined]
        yield D(client, clock)


ITEM = {"id": "physio", "kind": "visit", "title": "Physio visit", "time": "15:00", "date": DAY, "note": "Sam"}
ROUTINE = {"id": "water", "kind": "water", "title": "Drink some water", "every_min": 90, "start": "08:00", "end": "21:00"}


# -- defaults ------------------------------------------------------------------------------


def test_everything_starts_empty_and_carer_requests_off(d: D) -> None:
    s = d.state()
    assert s["settings"] == {"carer_notify": False, "carer_id": None, "speak_prompts": False}
    assert s["items"] == [] and s["routines"] == [] and s["marks"] == {}
    assert s["carer"] is None
    # The carers to choose from are Lifeline's contacts; the demo ones are simulated phones.
    assert [c["id"] for c in s["carers"]] == ["jordan", "morgan", "monitoring"]
    assert all(c["simulated"] and c["reachable"] for c in s["carers"])


def test_day_must_be_a_date(d: D) -> None:
    assert d.client.get("/api/daily?day=today").status_code == 422


# -- schedule -------------------------------------------------------------------------------


def test_schedule_is_validated_and_cleaned(d: D) -> None:
    put = d.client.put
    assert put("/api/daily/items", json={"items": [{**ITEM, "time": "25:00"}]}).status_code == 422
    assert put("/api/daily/items", json={"items": [{**ITEM, "days": [1]}]}).status_code == 422
    assert put("/api/daily/items", json={"items": [{**ITEM, "date": None, "days": [7]}]}).status_code == 422
    assert put("/api/daily/items", json={"items": [ITEM, ITEM]}).status_code == 422
    assert put("/api/daily/items", json={"items": [{**ITEM, "title": "   "}]}).status_code == 422
    assert put("/api/daily/items", json={"items": [{**ITEM, "extra": 1}]}).status_code == 422
    res = put("/api/daily/items", json={"items": [{**ITEM, "title": "Physio\n  visit\t"}]})
    assert res.status_code == 200, res.text
    assert d.state()["items"][0]["title"] == "Physio visit"


def test_done_later_and_undo(d: D) -> None:
    d.client.put("/api/daily/items", json={"items": [ITEM]})
    mark = d.client.post
    res = mark("/api/daily/marks", json={"item_id": "physio", "day": DAY, "status": "later"})
    assert res.status_code == 409 and "time" in res.json()["detail"]
    res = mark("/api/daily/marks", json={"item_id": "physio", "day": DAY, "status": "later", "until": "15:30"})
    assert res.json()["marks"]["physio"]["status"] == "later"
    assert d.state()["marks"]["physio"]["until"] == "15:30"
    mark("/api/daily/marks", json={"item_id": "physio", "day": DAY, "status": "done"})
    assert d.state()["marks"]["physio"]["status"] == "done"
    assert d.state()["marks"]["physio"]["until"] is None
    mark("/api/daily/marks", json={"item_id": "physio", "day": DAY, "status": "clear"})
    assert d.state()["marks"] == {}
    # Another day has its own marks.
    assert d.client.get("/api/daily?day=2026-10-13").json()["marks"] == {}
    gone = mark("/api/daily/marks", json={"item_id": "nothing", "day": DAY, "status": "done"})
    assert gone.status_code == 409


def test_only_two_weeks_of_marks_are_kept(d: D) -> None:
    d.client.put("/api/daily/items", json={"items": [{**ITEM, "date": None}]})
    for n in range(1, 18):
        day = f"2026-10-{n:02d}"
        d.client.post("/api/daily/marks", json={"item_id": "physio", "day": day, "status": "done"})
    kept = d.client.app.state.agency.db.get_state("daily_marks")  # type: ignore[attr-defined]
    assert len(kept) == 14 and "2026-10-01" not in kept and "2026-10-17" in kept


# -- routines -------------------------------------------------------------------------------


def test_routines_done_and_later(d: D) -> None:
    put = d.client.put
    assert put("/api/daily/routines", json={"routines": [{**ROUTINE, "every_min": 5}]}).status_code == 422
    assert put("/api/daily/routines", json={"routines": [{**ROUTINE, "end": "08:00"}]}).status_code == 422
    assert put("/api/daily/routines", json={"routines": [ROUTINE]}).status_code == 200
    done = d.client.post("/api/daily/routines/water/done").json()
    assert done == {"last_done_at": "2026-10-12T16:00:00.000Z", "snoozed_until": None}
    d.clock.advance(60)
    later = d.client.post("/api/daily/routines/water/later", json={"minutes": 20}).json()
    assert later == {"last_done_at": "2026-10-12T16:00:00.000Z", "snoozed_until": "2026-10-12T16:21:00.000Z"}
    assert d.state()["routine_state"]["water"] == later
    assert d.client.post("/api/daily/routines/water/later", json={"minutes": 1}).status_code == 422
    assert d.client.post("/api/daily/routines/nope/done").status_code == 409
    # Removing a routine forgets its state.
    put("/api/daily/routines", json={"routines": []})
    assert d.state()["routine_state"] == {}


# -- requests to a carer --------------------------------------------------------------------


def test_with_carer_requests_off_nothing_leaves_the_screen(d: D) -> None:
    r = d.ask("I'm cold")
    assert r["status"] == "shown" and r["carer"] is None
    assert d.client.get("/api/daily/outbox").json()["messages"] == []
    assert d.client.get("/api/lifeline/outbox").json()["messages"] == []
    assert d.state()["requests"][0]["text"] == "I'm cold"


def test_carer_must_be_a_saved_contact(d: D) -> None:
    res = d.client.put("/api/daily/settings", json={"carer_notify": True, "carer_id": "stranger"})
    assert res.status_code == 409


def test_a_request_reaches_the_chosen_carer_once_and_is_not_an_alert(d: D) -> None:
    d.settings(carer_notify=True, carer_id="jordan")
    assert d.state()["carer"]["name"] == "Jordan" and d.state()["carer"]["simulated"] is True
    r = d.ask("Turn me, please")
    assert r["status"] == "delivered" and r["simulated"] is True
    assert r["carer"] == {"id": "jordan", "name": "Jordan"}
    assert "token" not in r
    messages = d.client.get("/api/daily/outbox").json()["messages"]
    assert len(messages) == 1 and messages[0]["contact_id"] == "jordan"
    assert '"Turn me, please."' in messages[0]["body"] and "Not an emergency" in messages[0]["body"]
    # Lifeline's emergency path is untouched: no alert, nothing on its simulated phones.
    assert d.client.get("/api/lifeline/status").json()["open_alert"] is None
    assert d.client.get("/api/lifeline/outbox").json()["messages"] == []
    # The same words again within a minute aren't sent twice.
    again = d.ask("Turn me, please")
    assert again["duplicate"] is True and again["id"] == r["id"]
    assert len(d.client.get("/api/daily/outbox").json()["messages"]) == 1


def test_the_carer_answers_from_the_link_and_the_person_sees_it(d: D) -> None:
    d.settings(carer_notify=True, carer_id="jordan")
    d.ask("I need the bathroom")
    link = d.link()
    page = d.client.get(link)
    assert page.status_code == 200
    assert "is asking for you" in page.text and "Not an emergency" in page.text
    assert page.headers["cache-control"] == "no-store"
    assert "<script" not in page.text
    res = d.client.post(f"{link}/coming", follow_redirects=False)
    assert res.status_code == 303 and res.headers["location"].endswith("?done=coming")
    assert "can see that you&#x27;re on your way" in d.client.get(f"{link}?done=coming").text
    seen = d.state()["requests"][0]
    assert seen["reply"] == "coming" and seen["reply_words"] == "On my way"
    # Changing the answer works; nonsense answers and links don't.
    d.client.post(f"{link}/soon")
    assert d.state()["requests"][0]["reply_words"] == "In a few minutes"
    assert d.client.post(f"{link}/unlock").status_code == 404
    assert d.client.get("/carer/not-a-real-token").status_code == 404


def test_the_request_text_is_escaped_on_the_carer_page(d: D) -> None:
    d.settings(carer_notify=True, carer_id="jordan")
    d.ask('<script>alert("x")</script> please')
    page = d.client.get(d.link()).text
    assert "<script>" not in page and "&lt;script&gt;" in page


def test_old_requests_cant_be_answered(d: D) -> None:
    d.settings(carer_notify=True, carer_id="jordan")
    d.ask("I'm thirsty")
    link = d.link()
    d.clock.advance(7 * 3600)
    res = d.client.post(f"{link}/coming", follow_redirects=False)
    assert res.headers["location"].endswith("?done=old")
    assert d.state()["requests"][0]["reply"] is None
    assert "too old" in d.client.get(link).text


def test_requests_are_rate_limited(d: D) -> None:
    d.settings(carer_notify=True, carer_id="jordan")
    for n in range(6):
        d.ask(f"Request number {n}")
    res = d.client.post("/api/daily/requests", json={"kind": "help", "text": "One more"})
    assert res.status_code == 409 and "Lifeline" in res.json()["detail"]
    d.clock.advance(11 * 60)
    assert d.ask("One more")["status"] == "delivered"


def test_request_text_is_validated(d: D) -> None:
    post = d.client.post
    assert post("/api/daily/requests", json={"kind": "help", "text": ""}).status_code == 422
    assert post("/api/daily/requests", json={"kind": "help", "text": "x" * 161}).status_code == 422
    assert post("/api/daily/requests", json={"kind": "alarm", "text": "hi"}).status_code == 422
    assert post("/api/daily/requests", json={"kind": "help", "text": " \n\t "}).status_code == 422


def _real_carer(d: D, channel: str) -> None:
    current = d.client.get("/api/lifeline/settings").json()
    real = {"id": "sam", "name": "Sam", "role": "caregiver", "channel": channel, "address": "+14155550123"}
    res = d.client.put("/api/lifeline/settings", json={**current, "contacts": [*current["contacts"], real]})
    assert res.status_code == 200, res.text
    d.settings(carer_notify=True, carer_id="sam")


def test_a_real_carer_without_twilio_fails_plainly(d: D) -> None:
    _real_carer(d, "sms")
    assert "aren't set up" in d.state()["carer"]["how"]
    r = d.ask("Please come when you can")
    assert r["status"] == "failed" and r["simulated"] is False
    assert "aren't configured" in r["error"]
    assert d.client.get("/api/daily/outbox").json()["messages"] == []


def test_a_real_carer_gets_one_text_and_never_a_call(d: D) -> None:
    sent: list[str] = []

    def transport(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
        sent.append(url.rsplit("/", 1)[-1])
        assert form["To"] == "+14155550123"
        return 201, {"sid": "SM1"}

    d.client.app.state.agency.lifeline.channels.twilio = TwilioChannel(  # type: ignore[attr-defined]
        "AC1", "t", "+15005550006", transport=transport
    )
    _real_carer(d, "sms_call")  # even a contact Lifeline would call only gets a text
    assert d.state()["carer"]["how"] == "a real text message"
    r = d.ask("I'm too warm")
    assert r["status"] == "sent" and r["simulated"] is False
    assert sent == ["Messages.json"]


def test_daily_api_needs_the_token_but_the_carer_page_does_not(tmp_path: Path) -> None:
    with make_client(tmp_path, token="secret") as client:
        assert client.get(f"/api/daily?day={DAY}").status_code == 401
        headers = {"X-Agency-Token": "secret"}
        assert client.get(f"/api/daily?day={DAY}", headers=headers).status_code == 200
        assert client.get("/carer/anything").status_code == 404  # reached the page, not refused by the token
