"""Lifeline: emergency signalling, escalation, watchdog and check-ins.

Time is driven by a fake clock and the supervisor tick is called directly, so every timing rule
is tested exactly, without sleeping.
"""

from __future__ import annotations

import re
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agency.lifeline.channels import Delivery, Outgoing, TwilioChannel
from agency.lifeline.models import Contact
from agency.lifeline.service import LifelineService
from conftest import make_client


class Clock:
    def __init__(self) -> None:
        self.t = datetime(2026, 10, 10, 10, 0, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)


@dataclass
class H:
    client: TestClient
    svc: LifelineService
    clock: Clock

    def run(self, fn: Callable[..., Awaitable[Any]], *args: Any) -> Any:
        assert self.client.portal is not None
        return self.client.portal.call(fn, *args)

    def tick(self, seconds: float = 0) -> None:
        self.clock.advance(seconds)
        self.run(self.svc.tick)

    def status(self) -> dict[str, Any]:
        res = self.client.get("/api/lifeline/status")
        assert res.status_code == 200, res.text
        body: dict[str, Any] = res.json()
        return body

    def alert(self) -> dict[str, Any]:
        alert = self.status()["open_alert"]
        assert alert is not None
        return dict(alert)

    def help(self, **body: Any) -> dict[str, Any]:
        res = self.client.post("/api/lifeline/help", json=body)
        assert res.status_code == 200, res.text
        out: dict[str, Any] = res.json()
        return out

    def alerts_to(self, alert: dict[str, Any]) -> list[str]:
        return [n["contact_id"] for n in alert["notifications"] if n["purpose"] == "alert"]

    def settings(self, **changes: Any) -> dict[str, Any]:
        current = self.client.get("/api/lifeline/settings").json()
        res = self.client.put("/api/lifeline/settings", json={**current, **changes})
        assert res.status_code == 200, res.text
        out: dict[str, Any] = res.json()
        return out

    def link(self, contact_id: str, alert: dict[str, Any] | None = None) -> str:
        messages = self.client.get("/api/lifeline/outbox").json()["messages"]
        for m in messages:
            if m["contact_id"] == contact_id and m["link"] and (alert is None or m["alert_id"] == alert["id"]):
                link: str = m["link"]
                return link
        raise AssertionError(f"no link for {contact_id}")


def harness(client: TestClient) -> H:
    svc: LifelineService = client.app.state.agency.lifeline  # type: ignore[attr-defined]
    clock = Clock()
    svc.now = clock
    return H(client, svc, clock)


@pytest.fixture
def h(tmp_path: Path) -> Iterator[H]:
    with make_client(tmp_path) as c:
        yield harness(c)


def two_people(h: H) -> None:
    """Jordan then Morgan, no monitoring service (so nobody answers automatically)."""
    contacts = [c for c in h.client.get("/api/lifeline/settings").json()["contacts"] if c["id"] != "monitoring"]
    h.settings(contacts=contacts)


def activate(h: H, **body: Any) -> dict[str, Any]:
    h.help(**body)
    h.tick(9)
    alert = h.alert()
    assert alert["status"] == "active"
    return alert


# -- setup and readiness ------------------------------------------------------------------


def test_demo_lifeline_is_ready_and_uses_only_simulated_phones(h: H) -> None:
    status = h.status()
    assert status["ready"] is True, status["problems"]
    settings = status["settings"]
    assert settings["consent"] is True and settings["consented_at"]
    assert [c["id"] for c in settings["contacts"]] == ["jordan", "morgan", "monitoring"]
    assert {c["channel"] for c in settings["contacts"]} == {"demo"}
    assert status["open_alert"] is None
    assert status["monitor"]["armed"] is False


def test_settings_are_validated(h: H) -> None:
    current = h.client.get("/api/lifeline/settings").json()
    bad_phone = {**current, "contacts": [{"id": "x1", "name": "X", "channel": "sms", "address": "555-1234"}]}
    assert h.client.put("/api/lifeline/settings", json=bad_phone).status_code == 422
    dup = {**current, "contacts": [{"id": "a1", "name": "A"}, {"id": "a1", "name": "B"}]}
    assert h.client.put("/api/lifeline/settings", json=dup).status_code == 422
    assert h.client.put("/api/lifeline/settings", json={**current, "ack_timeout_s": 3}).status_code == 422
    assert h.client.put("/api/lifeline/settings", json={**current, "emergency_number": "9-1-1"}).status_code == 422
    assert h.client.put("/api/lifeline/settings", json={**current, "unknown": 1}).status_code == 422
    ok = {**current, "contacts": [{"id": "a1", "name": "A", "channel": "sms_call", "address": "+1 415 555 0100"}]}
    assert h.client.put("/api/lifeline/settings", json=ok).status_code == 200


def test_consent_time_is_recorded_by_the_coordinator(h: H) -> None:
    withdrawn = h.settings(consent=False, consented_at="2000-01-01T00:00:00Z")
    assert withdrawn["consented_at"] is None
    h.clock.advance(60)
    given = h.settings(consent=True, consented_at="2000-01-01T00:00:00Z")
    assert given["consented_at"] == "2026-10-10T10:01:00.000Z"


def test_problems_explain_what_is_missing(h: H) -> None:
    h.settings(consent=False)
    assert any("Consent" in p for p in h.status()["problems"])
    h.settings(consent=True, contacts=[{"id": "r1", "name": "Real", "channel": "sms", "address": "+14155550100"}])
    problems = h.status()["problems"]
    assert any("Twilio isn't configured" in p for p in problems)
    assert any("AGENCY_PUBLIC_URL" in p for p in problems)
    assert h.status()["ready"] is False


# -- help signal, countdown, cancel -------------------------------------------------------


def test_help_counts_down_then_alerts_the_first_contact(h: H) -> None:
    out = h.help(source="eye_signal")
    assert out["created"] is True
    alert = out["alert"]
    assert alert["status"] == "pending_cancel"
    assert alert["notifications"] == []
    h.tick(7)
    assert h.alert()["status"] == "pending_cancel"
    h.tick(1.5)
    alert = h.alert()
    assert alert["status"] == "active"
    assert h.alerts_to(alert) == ["jordan"]
    assert alert["notifications"][0]["status"] == "delivered"
    assert alert["waiting_on"] == ["Jordan"]
    assert alert["metrics"]["seconds_to_first_contact"] == 8.5
    body = h.client.get("/api/lifeline/outbox").json()["messages"][0]["body"]
    assert body.startswith("AGENCY ALERT: Riley signalled for help with their eyes")
    assert "/respond/" in body
    assert "token" not in alert["notifications"][0]


def test_cancel_during_countdown_contacts_nobody(h: H) -> None:
    alert = h.help()["alert"]
    res = h.client.post(f"/api/lifeline/alerts/{alert['id']}/cancel")
    assert res.status_code == 200
    assert res.json()["status"] == "cancelled"
    h.tick(30)
    assert h.status()["open_alert"] is None
    assert h.client.get("/api/lifeline/outbox").json()["messages"] == []
    assert h.client.get(f"/api/lifeline/alerts/{alert['id']}").json()["notifications"] == []


def test_call_now_skips_the_countdown(h: H) -> None:
    alert = h.help()["alert"]
    out = h.client.post(f"/api/lifeline/alerts/{alert['id']}/now").json()
    assert out["status"] == "active"
    assert h.alerts_to(out) == ["jordan"]
    assert any(e["kind"] == "call_now" for e in out["events"])
    again = h.client.post(f"/api/lifeline/alerts/{alert['id']}/now").json()
    assert h.alerts_to(again) == ["jordan"], "calling now twice doesn't alert anyone twice"


def test_cancel_is_refused_once_people_have_been_alerted(h: H) -> None:
    alert = activate(h)
    res = h.client.post(f"/api/lifeline/alerts/{alert['id']}/cancel")
    assert res.status_code == 409
    assert "all-clear" in res.json()["detail"]


def test_a_repeated_signal_never_opens_a_second_alert(h: H) -> None:
    first = h.help()["alert"]
    again = h.help(source="switch")
    assert again["created"] is False
    assert again["alert"]["id"] == first["id"]
    assert len(h.client.get("/api/lifeline/alerts").json()) == 1
    assert any(e["kind"] == "signal_repeated" for e in again["alert"]["events"])


def test_test_alerts_start_immediately_and_are_labelled(h: H) -> None:
    alert = h.help(test=True)["alert"]
    assert alert["status"] == "active"
    assert alert["is_test"] is True
    body = h.client.get("/api/lifeline/outbox").json()["messages"][0]["body"]
    assert body.startswith("TEST from AGENCY Lifeline (not an emergency)")


# -- escalation ---------------------------------------------------------------------------


def test_unanswered_alerts_escalate_and_then_repeat_to_everyone(h: H) -> None:
    two_people(h)
    activate(h)
    h.tick(44)
    assert h.alerts_to(h.alert()) == ["jordan"]
    h.tick(2)
    alert = h.alert()
    assert h.alerts_to(alert) == ["jordan", "morgan"]
    assert alert["level"] == 1
    morgan_msg = h.client.get("/api/lifeline/outbox").json()["messages"][0]
    assert morgan_msg["contact_id"] == "morgan"
    assert "Jordan (caregiver) didn't answer within 45 s" in morgan_msg["body"]
    h.tick(46)
    alert = h.alert()
    assert alert["cycle"] == 1
    assert h.alerts_to(alert) == ["jordan", "morgan", "jordan", "morgan"]
    assert alert["status"] == "active"
    h.tick(89)
    assert len(h.alerts_to(h.alert())) == 4
    h.tick(2)
    assert len(h.alerts_to(h.alert())) == 6
    assert h.alert()["cycle"] == 2


def test_simulated_monitoring_center_answers_like_a_staffed_centre(h: H) -> None:
    activate(h)
    h.tick(46)
    h.tick(46)
    assert h.alerts_to(h.alert()) == ["jordan", "morgan", "monitoring"]
    h.tick(11)
    assert h.alert()["status"] == "active"
    h.tick(2)
    alert = h.alert()
    assert alert["status"] == "acknowledged"
    assert alert["acknowledged_by"] == "Demo Monitoring Center operator"
    stand_downs = {n["contact_id"] for n in alert["notifications"] if n["purpose"] == "stand_down"}
    assert stand_downs == {"jordan", "morgan"}


def test_decline_moves_on_immediately(h: H) -> None:
    two_people(h)
    alert = activate(h)
    res = h.client.post(f"{h.link('jordan')}/decline", follow_redirects=False)
    assert res.status_code == 303
    alert = h.alert()
    assert h.alerts_to(alert) == ["jordan", "morgan"]
    assert any("couldn't be reached or can't come" in e["message"] for e in alert["events"])


def test_unreachable_first_contact_fails_over_without_waiting(h: H) -> None:
    res = h.client.put("/api/demo/faults", json={"lifeline_primary_unreachable": True})
    assert res.json()["lifeline_primary_unreachable"] is True
    alert = h.help(test=True)["alert"]
    statuses = {n["contact_id"]: n["status"] for n in alert["notifications"] if n["purpose"] == "alert"}
    assert statuses == {"jordan": "failed", "morgan": "delivered"}
    assert alert["level"] == 1
    assert any(e["kind"] == "delivery_failed" for e in alert["events"])
    phones = {m["contact_id"] for m in h.client.get("/api/lifeline/outbox").json()["messages"]}
    assert phones == {"morgan"}, "a message that failed to deliver never reaches the (simulated) phone"


def test_never_gives_up_when_nobody_can_be_reached(h: H) -> None:
    h.settings(
        contacts=[
            {"id": "a1", "name": "Alex", "channel": "sms", "address": "+14155550100", "priority": 1},
            {"id": "b1", "name": "Bo", "channel": "sms", "address": "+14155550101", "priority": 2},
        ]
    )
    alert = h.help(test=True)["alert"]
    assert [n["status"] for n in alert["notifications"]] == ["failed", "failed"]
    assert alert["status"] == "active"
    assert any(e["kind"] == "unreachable" for e in alert["events"])
    assert "TWILIO_" in alert["notifications"][0]["error"]
    h.tick(91)
    alert = h.alert()
    assert alert["status"] == "active"
    assert alert["cycle"] == 1
    assert len(alert["notifications"]) == 4


# -- responses ----------------------------------------------------------------------------


def test_acknowledging_stops_escalation_and_stands_down_the_others(h: H) -> None:
    two_people(h)
    activate(h)
    h.tick(46)
    link = h.link("jordan")
    page = h.client.get(link)
    assert page.status_code == 200
    assert "Riley needs help" in page.text
    assert "I&#x27;m on my way" in page.text or "I'm on my way" in page.text
    assert "Penicillin" in page.text
    res = h.client.post(f"{link}/ack", follow_redirects=False)
    assert res.status_code == 303
    assert res.headers["location"] == f"{link}?done=ack"
    alert = h.alert()
    assert alert["status"] == "acknowledged"
    assert alert["acknowledged_by"] == "Jordan"
    assert alert["metrics"]["seconds_to_acknowledged"] == 55.0
    assert [n["contact_id"] for n in alert["notifications"] if n["purpose"] == "stand_down"] == ["morgan"]
    h.tick(600)
    assert len(h.alerts_to(h.alert())) == 2
    page = h.client.get(f"{link}?done=ack").text
    assert "You&#x27;re on the way" in page or "You're on the way" in page
    assert "can see that you" in page


def test_a_second_responder_is_recorded_too(h: H) -> None:
    two_people(h)
    activate(h)
    h.tick(46)
    h.client.post(f"{h.link('jordan')}/ack")
    res = h.client.post(f"{h.link('morgan')}/ack", follow_redirects=False)
    assert res.headers["location"].endswith("done=ack_also")
    alert = h.alert()
    assert alert["acknowledged_by"] == "Jordan"
    assert any(e["kind"] == "acknowledged_also" for e in alert["events"])


def test_a_withdrawn_acknowledgement_reopens_the_alert(h: H) -> None:
    two_people(h)
    activate(h)
    link = h.link("jordan")
    h.client.post(f"{link}/ack")
    assert h.alert()["status"] == "acknowledged"
    h.client.post(f"{link}/decline")
    alert = h.alert()
    assert alert["status"] == "active"
    assert alert["acknowledged_by"] is None
    assert h.alerts_to(alert) == ["jordan", "morgan"]
    assert any(e["kind"] == "reopened" for e in alert["events"])


def test_contact_can_end_the_alert_and_everyone_gets_an_all_clear(h: H) -> None:
    two_people(h)
    activate(h)
    h.tick(46)
    link = h.link("jordan")
    h.client.post(f"{link}/ack")
    page = h.client.get(link).text
    assert f'href="{link}?confirm=resolve"' in page, "ending the alert is a link to a confirmation, not a one-tap action"
    confirm = h.client.get(f"{link}?confirm=resolve").text
    assert "Are you with Riley, and are they safe?" in confirm
    assert f'action="{link}/resolve"' in confirm
    assert h.alert()["status"] == "acknowledged"
    res = h.client.post(f"{link}/resolve", follow_redirects=False)
    assert res.headers["location"].endswith("done=resolve")
    alert = h.client.get(f"/api/lifeline/alerts/{h.status()['recent'][0]['id']}").json()
    assert alert["status"] == "resolved"
    assert alert["resolved_by"] == "Jordan"
    assert [n["contact_id"] for n in alert["notifications"] if n["purpose"] == "all_clear"] == ["morgan"]
    page = h.client.get(link).text
    assert "This alert has ended" in page
    assert "Penicillin" not in page
    assert "<form" not in page
    assert h.status()["open_alert"] is None


def test_person_can_end_the_alert_from_their_screen(h: H) -> None:
    alert = activate(h)
    res = h.client.post(f"/api/lifeline/alerts/{alert['id']}/resolve")
    assert res.status_code == 200
    out = res.json()
    assert out["status"] == "resolved"
    assert out["resolved_by"] == "Riley"
    assert [n["contact_id"] for n in out["notifications"] if n["purpose"] == "all_clear"] == ["jordan"]
    assert h.client.post(f"/api/lifeline/alerts/{alert['id']}/resolve").json()["status"] == "resolved"


def test_without_consent_only_the_local_alarm_sounds(h: H) -> None:
    h.settings(consent=False)
    alert = h.help(test=True)["alert"]
    assert alert["status"] == "active"
    assert alert["local_only"] is True
    assert alert["notifications"] == []
    assert any("consent" in e["message"] for e in alert["events"])
    h.tick(1000)
    assert h.alert()["notifications"] == []


# -- the responder page -------------------------------------------------------------------


def test_responder_page_escapes_everything_and_sets_safe_headers(h: H) -> None:
    current = h.client.get("/api/lifeline/settings").json()
    hostile = "<script>alert(1)</script>"
    h.settings(
        contacts=[{**current["contacts"][0], "name": "<b>Jo</b>"}],
        responder={**current["responder"], "person_name": "<i>R</i>", "notes": hostile},
    )
    activate(h)
    res = h.client.get(h.link("jordan"))
    assert hostile not in res.text
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in res.text
    assert "<i>R</i>" not in res.text
    assert "<script" not in res.text
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["referrer-policy"] == "no-referrer"
    assert "default-src 'none'" in res.headers["content-security-policy"]


def test_bad_links_and_actions_are_refused(h: H) -> None:
    assert h.client.get("/respond/not-a-real-token").status_code == 404
    assert h.client.post("/respond/not-a-real-token/ack").status_code == 404
    activate(h)
    link = h.link("jordan")
    assert h.client.post(f"{link}/delete").status_code == 404
    assert h.client.get("/respond/" + "x" * 500).status_code == 404


def test_tokens_are_unique_and_unguessable(h: H) -> None:
    activate(h)
    h.tick(46)
    links = [m["link"] for m in h.client.get("/api/lifeline/outbox").json()["messages"] if m["link"]]
    tokens = [link.rsplit("/", 1)[1] for link in links]
    assert len(set(tokens)) == len(tokens) == 2
    assert all(len(t) >= 24 and re.fullmatch(r"[A-Za-z0-9_-]+", t) for t in tokens)


def test_respond_pages_need_no_coordinator_token_but_the_api_does(tmp_path: Path) -> None:
    with make_client(tmp_path, token="secret-token") as c:  # noqa: S106 - test value
        hh = harness(c)
        assert c.get("/api/lifeline/status").status_code == 401
        headers = {"X-Agency-Token": "secret-token"}
        c.post("/api/lifeline/help", json={"test": True}, headers=headers)
        messages = c.get("/api/lifeline/outbox", headers=headers).json()["messages"]
        link = messages[0]["link"]
        assert c.get(link).status_code == 200
        assert c.post(f"{link}/ack", follow_redirects=False).status_code == 303
        assert hh.svc.status()["open_alert"]["status"] == "acknowledged"


# -- watch over me ------------------------------------------------------------------------


def test_watchdog_alerts_when_the_interface_goes_silent(h: H) -> None:
    h.tick(120)
    assert h.status()["open_alert"] is None, "no watchdog unless Watch over me is on"
    assert h.client.post("/api/lifeline/monitoring", json={"armed": True}).json()["monitor"]["armed"] is True
    h.tick(20)
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True, "camera": "running", "face_visible": True})
    h.tick(29)
    assert h.status()["open_alert"] is None
    h.tick(2)
    alert = h.alert()
    assert alert["kind"] == "watchdog"
    assert alert["status"] == "active", "watchdog alerts skip the countdown: the person may not be able to cancel"
    assert h.alerts_to(alert) == ["jordan"]
    assert "stopped responding" in h.client.get("/api/lifeline/outbox").json()["messages"][0]["body"]
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    alert = h.alert()
    assert alert["status"] == "active", "the computer coming back doesn't end the alert; a person must check"
    assert any(e["kind"] == "interface_back" for e in alert["events"])


def test_watchdog_fires_once_per_silence(h: H) -> None:
    h.client.post("/api/lifeline/monitoring", json={"armed": True})
    h.tick(31)
    alert = h.alert()
    h.client.post(f"/api/lifeline/alerts/{alert['id']}/resolve")
    h.tick(60)
    assert h.status()["open_alert"] is None
    assert len(h.client.get("/api/lifeline/alerts").json()) == 1


def test_turning_watch_over_me_off_stops_the_watchdog(h: H) -> None:
    h.client.post("/api/lifeline/monitoring", json={"armed": True})
    h.client.post("/api/lifeline/monitoring", json={"armed": False})
    h.tick(300)
    assert h.status()["open_alert"] is None


def test_missed_check_in_raises_an_alert(h: H) -> None:
    h.settings(checkin_interval_min=1, watchdog_timeout_s=600)
    h.client.post("/api/lifeline/monitoring", json={"armed": True})
    h.tick(61)
    assert h.status()["monitor"]["checkin_pending_since"] is not None
    h.client.post("/api/lifeline/checkin", json={"source": "dwell"})
    monitor = h.status()["monitor"]
    assert monitor["checkin_pending_since"] is None
    assert monitor["next_checkin_at"] == "2026-10-10T10:02:01.000Z"
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    h.tick(60)
    assert h.status()["monitor"]["checkin_pending_since"] is not None
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    h.tick(89)
    assert h.status()["open_alert"] is None
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    h.tick(2)
    alert = h.alert()
    assert alert["kind"] == "checkin_missed"
    assert alert["status"] == "active"


def test_turning_watch_over_me_off_clears_a_waiting_check_in(h: H) -> None:
    h.client.post("/api/lifeline/monitoring", json={"armed": True})
    h.client.post("/api/lifeline/demo/checkin-now")
    assert h.status()["monitor"]["checkin_pending_since"] is not None
    h.client.post("/api/lifeline/monitoring", json={"armed": False})
    monitor = h.status()["monitor"]
    assert monitor["checkin_pending_since"] is None
    assert monitor["next_checkin_at"] is None
    h.tick(600)
    assert h.status()["open_alert"] is None


def test_presenter_can_ask_for_a_check_in_now(h: H) -> None:
    assert h.client.post("/api/lifeline/demo/checkin-now").status_code == 409, "only while Watch over me is on"
    h.client.post("/api/lifeline/monitoring", json={"armed": True})
    out = h.client.post("/api/lifeline/demo/checkin-now").json()
    assert out["monitor"]["checkin_pending_since"] is not None
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    h.tick(29)
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    h.tick(29)
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    h.tick(29)
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": True})
    h.tick(4)
    alert = h.alert()
    assert alert["kind"] == "checkin_missed", "an unanswered check-in raises an alert even with no schedule"
    assert h.status()["monitor"]["checkin_pending_since"] is None
    assert h.status()["monitor"]["next_checkin_at"] is None


def test_signal_unavailable_alert_is_optional(h: H) -> None:
    h.client.post("/api/lifeline/monitoring", json={"armed": True})
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": False, "camera": "off"})
    for _ in range(10):
        h.client.post("/api/lifeline/heartbeat", json={"signal_ready": False, "camera": "off"})
        h.tick(25)
    assert h.status()["open_alert"] is None
    h.settings(alert_on_signal_unavailable=True, signal_grace_s=60)
    h.client.post("/api/lifeline/heartbeat", json={"signal_ready": False})
    h.tick(1)
    alert = h.alert()
    assert alert["kind"] == "signal_unavailable"


# -- persistence, reporting, reset --------------------------------------------------------


def test_an_open_alert_survives_a_coordinator_restart_and_keeps_escalating(tmp_path: Path) -> None:
    with make_client(tmp_path) as c:
        hh = harness(c)
        two_people(hh)
        activate(hh)
        alert_id = hh.alert()["id"]
        restart_at = hh.clock.t + timedelta(seconds=30)
    with make_client(tmp_path) as c:
        hh = harness(c)
        hh.clock.t = restart_at
        alert = hh.alert()
        assert alert["id"] == alert_id
        assert any(e["kind"] == "coordinator_restarted" for e in alert["events"])
        hh.tick(16)
        assert hh.alerts_to(hh.alert()) == ["jordan", "morgan"]


def test_report_measures_time_to_help(h: H) -> None:
    alert = h.help()["alert"]
    h.client.post(f"/api/lifeline/alerts/{alert['id']}/cancel")
    activate(h, test=True)
    h.tick(20)
    h.client.post(f"{h.link('jordan')}/ack")
    report = h.client.get("/api/lifeline/report").json()
    assert report["alerts"] == 2
    assert report["tests"] == 1
    assert report["cancelled_in_countdown"] == 1
    assert report["acknowledged"] == 1
    assert report["median_seconds_to_acknowledged"] == 29.0, "activate() waits out the 9 s countdown first"
    assert report["open"] == 1


def test_demo_reset_clears_lifeline_history(h: H) -> None:
    activate(h)
    h.client.post("/api/lifeline/monitoring", json={"armed": True})
    assert h.client.post("/api/demo/reset").status_code == 200
    status = h.status()
    assert status["open_alert"] is None
    assert status["recent"] == []
    assert status["monitor"]["armed"] is False
    assert h.client.get("/api/lifeline/outbox").json()["messages"] == []


# -- Twilio channel (with a fake transport; no network) -----------------------------------


def _outgoing(channel: str, purpose: str = "alert") -> Outgoing:
    contact = Contact(id="a1", name="Alex", channel=channel, address="+1 415 555 0100")  # type: ignore[arg-type]
    return Outgoing(contact, "AGENCY ALERT: body", "Riley <needs> help & fast", purpose, True)


def test_twilio_sends_a_text_and_a_call_that_reads_the_alert_aloud(h: H) -> None:
    calls: list[tuple[str, dict[str, str], str]] = []

    def transport(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
        calls.append((url, form, auth))
        return 201, {"sid": "SM1" if url.endswith("Messages.json") else "CA1"}

    channel = TwilioChannel("AC123", "tok", "+15005550006", transport=transport)
    delivery: Delivery = h.run(channel.send, _outgoing("sms_call"))
    assert delivery.status == "sent" and delivery.simulated is False
    assert delivery.provider_ref == "SM1,CA1"
    (sms_url, sms, auth), (call_url, call, _) = calls
    assert sms_url == "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"
    assert sms == {"To": "+14155550100", "From": "+15005550006", "Body": "AGENCY ALERT: body"}
    assert auth and "tok" not in auth
    assert call_url.endswith("/Calls.json")
    assert "Riley &lt;needs&gt; help &amp; fast" in call["Twiml"]
    assert "<needs>" not in call["Twiml"]

    calls.clear()
    h.run(channel.send, _outgoing("sms_call", purpose="all_clear"))
    assert len(calls) == 1, "only alerts place a call"


def test_twilio_failures_are_reported_not_hidden(h: H) -> None:
    def rejects(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
        return 400, {"message": "The 'To' number is not a valid phone number."}

    def offline(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
        raise OSError("network down")

    failed: Delivery = h.run(TwilioChannel("AC1", "t", "+15005550006", transport=rejects).send, _outgoing("sms"))
    assert failed.status == "failed"
    assert failed.error and "not a valid phone number" in failed.error
    down: Delivery = h.run(TwilioChannel("AC1", "t", "+15005550006", transport=offline).send, _outgoing("sms"))
    assert down.status == "failed"
    assert down.error and "network error" in down.error


def test_real_channel_through_the_service(h: H) -> None:
    sent: list[dict[str, str]] = []

    def transport(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
        sent.append(form)
        return 201, {"sid": "SM9"}

    h.svc.channels.twilio = TwilioChannel("AC1", "t", "+15005550006", transport=transport)
    h.settings(contacts=[{"id": "a1", "name": "Alex", "channel": "sms", "address": "+14155550100"}])
    alert = h.help(test=True)["alert"]
    assert alert["notifications"][0]["status"] == "sent"
    assert sent[0]["To"] == "+14155550100"
    assert sent[0]["Body"].startswith("TEST from AGENCY Lifeline")
    assert h.client.get("/api/lifeline/outbox").json()["messages"] == [], "real messages are not shown as simulated phones"


def test_alerts_that_could_not_get_out_are_sent_again_when_the_network_is_back(h: H) -> None:
    network_up = False
    sent: list[dict[str, str]] = []

    def transport(url: str, form: dict[str, str], auth: str) -> tuple[int, dict[str, Any]]:
        if not network_up:
            raise OSError("network down")
        sent.append(form)
        return 201, {"sid": f"SM{len(sent)}"}

    h.svc.channels.twilio = TwilioChannel("AC1", "t", "+15005550006", transport=transport)
    h.settings(
        contacts=[
            {"id": "a1", "name": "Alex", "channel": "sms", "address": "+14155550100", "priority": 1},
            {"id": "b1", "name": "Bo", "channel": "sms", "address": "+14155550101", "priority": 2},
        ]
    )
    alert = activate(h)
    assert [n["status"] for n in alert["notifications"]] == ["failed", "failed"]
    assert alert["next_escalation_at"] is not None

    # The network comes back (the presenter control moves AGENCY's monitor exactly as the sentinel would). Lifeline
    # must not wait for the next escalation, which could be a minute and a half away.
    network_up = True
    h.client.put("/api/demo/network", json={"state": "offline"})
    h.client.put("/api/demo/network", json={"state": "good"})
    for _ in range(200):
        if len(sent) == 2:
            break
        time.sleep(0.01)
    assert sorted(m["To"] for m in sent) == ["+14155550100", "+14155550101"]
    assert all("The network was down" in m["Body"] for m in sent)
    alert = h.alert()
    assert [n["status"] for n in alert["notifications"] if n["purpose"] == "alert"] == ["failed", "failed", "sent", "sent"]
    assert any(e["kind"] == "network_back" for e in alert["events"])
    assert alert["waiting_on"] == ["Alex", "Bo"]
    # They get a full answer window before everyone is alerted again.
    due = datetime.fromisoformat(alert["next_escalation_at"].replace("Z", "+00:00"))
    assert due >= h.clock() + timedelta(seconds=45)

    # Already reached: another recovery sends nothing new.
    assert h.run(h.svc.network_back) == []
    assert len(sent) == 2
