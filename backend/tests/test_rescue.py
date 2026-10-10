"""Lifeline rescue: saying what's wrong, talking with eyes, the helper's checklist, emergency
services (simulated), the door, the lights and the ventilator's power. Fake clock throughout."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from agency.lifeline.home import HomeAssistantHome
from agency.services.seed import ensure_seeded
from conftest import make_client
from test_lifeline import H, activate, harness, two_people


@pytest.fixture
def h(tmp_path: Path) -> Iterator[H]:
    with make_client(tmp_path) as c:
        yield harness(c)


def alerts_to(alert: dict[str, Any]) -> list[str]:
    return [n["contact_id"] for n in alert["notifications"] if n["purpose"] == "alert"]


def updates_to(alert: dict[str, Any]) -> list[str]:
    return [n["contact_id"] for n in alert["notifications"] if n["purpose"] == "update"]


def kinds(alert: dict[str, Any]) -> list[str]:
    return [e["kind"] for e in alert["events"]]


def situation(h: H, key: str) -> dict[str, Any]:
    res = h.client.post(f"/api/lifeline/alerts/{h.alert()['id']}/situation", json={"situation": key})
    assert res.status_code == 200, res.text
    out: dict[str, Any] = res.json()
    return out


def device(h: H, device_id: str) -> str:
    devices = h.client.get("/api/demo-services/home/devices").json()["devices"]
    return str(next(d for d in devices if d["id"] == device_id)["state"])


# -- saying what's wrong ------------------------------------------------------------------


def test_saying_its_breathing_makes_the_alert_critical_and_alerts_everyone_at_once(h: H) -> None:
    activate(h)
    assert alerts_to(h.alert()) == ["jordan"]
    alert = situation(h, "breathing")
    assert alert["situation"] == "breathing"
    assert alert["urgency"] == "critical"
    assert sorted(alerts_to(alert)) == ["jordan", "monitoring", "morgan"]
    assert updates_to(alert) == ["jordan"], "whoever was already alerted is told what's wrong"
    assert "Critical: alerting everyone at once" in " ".join(e["message"] for e in alert["events"])
    morgan = next(m for m in h.client.get("/api/lifeline/outbox").json()["messages"] if m["contact_id"] == "morgan")
    assert "CRITICAL" in morgan["body"]
    assert "Riley says: breathing or mask" in morgan["body"]


def test_critical_during_the_countdown_starts_the_alert_straight_away(h: H) -> None:
    h.help()
    alert = situation(h, "choking")
    assert alert["status"] == "active"
    assert sorted(alerts_to(alert)) == ["jordan", "monitoring", "morgan"]


def test_a_non_critical_answer_only_updates_people(h: H) -> None:
    activate(h)
    alert = situation(h, "pain")
    assert alert["urgency"] == "urgent"
    assert alerts_to(alert) == ["jordan"]
    assert updates_to(alert) == ["jordan"]


def test_urgency_never_goes_down(h: H) -> None:
    activate(h)
    situation(h, "breathing")
    alert = situation(h, "pain")
    assert alert["situation"] == "pain"
    assert alert["urgency"] == "critical"


def test_situation_is_validated(h: H) -> None:
    activate(h)
    res = h.client.post(f"/api/lifeline/alerts/{h.alert()['id']}/situation", json={"situation": "anything"})
    assert res.status_code == 422


# -- talking with eyes ----------------------------------------------------------------------


def test_a_helper_asks_and_the_person_answers_with_their_eyes(h: H) -> None:
    activate(h)
    link = h.link("jordan")
    res = h.client.post(f"{link}/ask/breathing", follow_redirects=False)
    assert res.status_code == 303
    assert res.headers["location"].endswith("done=asked")
    question = h.alert()["pending_question"]
    assert question["text"] == "Is it your breathing?"
    assert question["asked_by"] == "Jordan"
    page = h.client.get(link).text
    assert "waiting for an answer" in page
    assert 'http-equiv="refresh" content="5"' in page, "the page refreshes faster while waiting for an answer"
    out = h.client.post(f"/api/lifeline/questions/{question['id']}/answer", json={"answer": "yes"}).json()
    assert out["pending_question"] is None
    assert "Riley answered Yes: Is it your breathing?" in [e["message"] for e in out["events"]]
    assert 'Is it your breathing? <span class="answer">Yes</span>' in h.client.get(link).text


def test_custom_questions_are_limited_and_escaped(h: H) -> None:
    activate(h)
    link = h.link("jordan")
    form = {"Content-Type": "application/x-www-form-urlencoded"}
    res = h.client.post(
        f"{link}/ask", content="text=Is+the+%3Cb%3Emask%3C%2Fb%3E+hurting%3F", headers=form, follow_redirects=False
    )
    assert res.headers["location"].endswith("done=asked")
    assert h.alert()["pending_question"]["text"] == "Is the <b>mask</b> hurting?"
    page = h.client.get(link).text
    assert "<b>mask</b>" not in page and "&lt;b&gt;mask&lt;/b&gt;" in page
    short = h.client.post(f"{link}/ask", content="text=a", headers=form, follow_redirects=False)
    assert short.headers["location"].endswith("done=ask_invalid")
    h.client.post(f"{link}/ask/pain")
    h.client.post(f"{link}/ask/hurry")
    too_many = h.client.post(f"{link}/ask/ok", follow_redirects=False)
    assert too_many.headers["location"].endswith("done=too_many"), "at most three unanswered questions at once"
    assert h.client.post(f"{link}/ask/not-a-preset").status_code == 404


def test_answering_a_question_twice_keeps_the_first_answer(h: H) -> None:
    activate(h)
    h.client.post(f"{h.link('jordan')}/ask/pain")
    qid = h.alert()["pending_question"]["id"]
    h.client.post(f"/api/lifeline/questions/{qid}/answer", json={"answer": "no"})
    h.client.post(f"/api/lifeline/questions/{qid}/answer", json={"answer": "yes"})
    assert h.alert()["questions"][0]["answer"] == "no"
    assert h.client.post(f"/api/lifeline/questions/{qid}/answer", json={"answer": "maybe"}).status_code == 422


# -- emergency services (simulated in this build) ----------------------------------------


def test_answering_yes_to_an_ambulance_requests_emergency_services(h: H) -> None:
    activate(h)
    h.client.post(f"{h.link('jordan')}/ask/ambulance")
    qid = h.alert()["pending_question"]["id"]
    alert = h.client.post(f"/api/lifeline/questions/{qid}/answer", json={"answer": "yes"}).json()
    dispatch = alert["dispatch"]
    assert dispatch["status"] == "requested"
    assert dispatch["simulated"] is True
    assert dispatch["provider"] == "Demo Emergency Dispatch"
    assert dispatch["requested_by"] == "Riley"
    assert "answered yes" in dispatch["reason"]
    assert "dispatch_requested" in kinds(alert)
    assert updates_to(alert) == ["jordan"]
    assert device(h, "front_door") == "unlocked", "the demo allows unlocking for emergency services"
    h.tick(7)
    alert = h.alert()
    assert alert["dispatch"]["status"] == "accepted"
    assert "ambulance is on the way" in alert["dispatch"]["summary"]
    assert "(simulated)" in alert["dispatch"]["summary"]


def test_a_critical_alert_nobody_answers_requests_emergency_services_once(h: H) -> None:
    two_people(h)
    activate(h)
    situation(h, "breathing")
    h.tick(89)
    assert h.alert()["dispatch"] is None
    h.tick(2)
    alert = h.alert()
    assert alert["dispatch"]["status"] == "requested"
    assert alert["dispatch"]["requested_by"] == "AGENCY"
    assert "no one answered within 90 s" in alert["dispatch"]["reason"]
    h.tick(300)
    assert len([e for e in h.alert()["events"] if e["kind"] == "dispatch_requested"]) == 1


def test_no_automatic_request_once_someone_is_on_the_way(h: H) -> None:
    two_people(h)
    activate(h)
    situation(h, "breathing")
    h.tick(10)
    h.client.post(f"{h.link('jordan')}/ack")
    h.tick(300)
    assert h.alert()["dispatch"] is None


def test_a_helper_can_request_and_cancel_an_ambulance_with_confirmation(h: H) -> None:
    activate(h)
    link = h.link("jordan")
    confirm = h.client.get(f"{link}?confirm=dispatch").text
    assert "Request an ambulance for Riley?" in confirm
    assert "simulated and no one is sent" in confirm
    assert h.alert()["dispatch"] is None, "opening the confirmation does nothing by itself"
    res = h.client.post(f"{link}/dispatch", follow_redirects=False)
    assert res.headers["location"].endswith("done=dispatched")
    assert h.alert()["dispatch"]["requested_by"] == "Jordan"
    h.client.post(f"{link}/dispatch")
    assert len([e for e in h.alert()["events"] if e["kind"] == "dispatch_requested"]) == 1, "never requested twice"
    res = h.client.post(f"{link}/dispatch-cancel", follow_redirects=False)
    assert res.headers["location"].endswith("done=dispatch_cancelled")
    assert h.alert()["dispatch"]["status"] == "cancelled"


def test_ending_an_alert_does_not_silently_cancel_emergency_services(h: H) -> None:
    alert = activate(h)
    h.client.post(f"/api/lifeline/alerts/{alert['id']}/dispatch", json={})
    out = h.client.post(f"/api/lifeline/alerts/{alert['id']}/resolve").json()
    assert "dispatch_still_active" in kinds(out)
    clear = next(n for n in out["notifications"] if n["purpose"] == "all_clear")
    assert "have not been cancelled" in clear["body"]


def test_without_permission_emergency_services_are_not_requested(h: H) -> None:
    current = h.client.get("/api/lifeline/settings").json()
    h.settings(dispatch={**current["dispatch"], "consent": False})
    alert = activate(h)
    out = h.client.post(f"/api/lifeline/alerts/{alert['id']}/dispatch", json={}).json()
    assert out["dispatch"]["status"] == "not_allowed"
    assert "dispatch_not_allowed" in kinds(out)
    update = next(n for n in out["notifications"] if n["purpose"] == "update")
    assert "Call 911" in update["body"]
    assert "Request an ambulance" not in h.client.get(h.link("jordan")).text


def test_test_alerts_never_request_emergency_services(h: H) -> None:
    alert = h.help(test=True)["alert"]
    out = h.client.post(f"/api/lifeline/alerts/{alert['id']}/dispatch", json={}).json()
    assert out["dispatch"]["status"] == "test_skipped"
    assert "Nothing was sent" in " ".join(e["message"] for e in out["events"])
    assert device(h, "front_door") == "locked"


# -- the helper's checklist and arrival -------------------------------------------------


def test_the_helper_follows_the_care_plan_and_progress_is_shared(h: H) -> None:
    activate(h)
    situation(h, "breathing")
    link = h.link("jordan")
    page = h.client.get(link).text
    assert "What to do: Breathing or mask" in page
    assert "Check the mask is on and sealed" in page
    assert "Example care plan for the fictional demo profile" in page
    res = h.client.post(f"{link}/step/1", follow_redirects=False)
    assert res.headers["location"].endswith("done=step")
    h.client.post(f"{link}/step/1")
    steps = h.alert()["plan"]["steps"]
    assert steps[1]["done_by"] == "Jordan" and steps[1]["done_at"]
    assert [s["done_by"] for s in steps].count("Jordan") == 1
    assert len([e for e in h.alert()["events"] if e["kind"] == "step_done"]) == 1
    assert h.client.post(f"{link}/step/99").status_code == 404


def test_before_anyone_says_whats_wrong_helpers_see_the_first_steps(h: H) -> None:
    activate(h)
    plan = h.alert()["plan"]
    assert plan["key"] == "general"
    assert plan["label"] == "First steps"
    assert "yes/no questions" in plan["steps"][1]["label"]


def test_arriving_counts_as_on_my_way_and_is_recorded(h: H) -> None:
    two_people(h)
    activate(h)
    h.tick(20)
    res = h.client.post(f"{h.link('jordan')}/arrived", follow_redirects=False)
    assert res.headers["location"].endswith("done=arrived")
    alert = h.alert()
    assert alert["status"] == "acknowledged"
    assert alert["arrivals"][0]["contact_name"] == "Jordan"
    assert "Jordan is with Riley now (29 s after the signal)." in [e["message"] for e in alert["events"]]


# -- the home ---------------------------------------------------------------------------------


def test_the_door_unlocks_only_for_a_helper_who_is_coming_and_locks_again(h: H) -> None:
    activate(h)
    link = h.link("jordan")
    assert "unlock it" not in h.client.get(link).text
    res = h.client.post(f"{link}/unlock", follow_redirects=False)
    assert res.headers["location"].endswith("done=unlock_needs_ack")
    assert device(h, "front_door") == "locked"
    h.client.post(f"{link}/ack")
    assert "I'm at the door: unlock it" in h.client.get(link).text
    res = h.client.post(f"{link}/unlock", follow_redirects=False)
    assert res.headers["location"].endswith("done=unlocked")
    assert device(h, "front_door") == "unlocked"
    assert h.alert()["door_unlocked_for"] == "Jordan"
    h.tick(15 * 60 - 1)
    assert device(h, "front_door") == "unlocked"
    h.tick(2)
    assert device(h, "front_door") == "locked"
    assert "door_locked" in kinds(h.alert())


def test_the_door_locks_when_the_alert_ends(h: H) -> None:
    alert = activate(h)
    link = h.link("jordan")
    h.client.post(f"{link}/ack")
    h.client.post(f"{link}/unlock")
    h.client.post(f"/api/lifeline/alerts/{alert['id']}/resolve")
    assert device(h, "front_door") == "locked"


def test_unlocking_needs_permission_and_never_happens_in_a_test(h: H) -> None:
    current = h.client.get("/api/lifeline/settings").json()
    h.settings(home={**current["home"], "unlock_for_responders": False})
    activate(h)
    link = h.link("jordan")
    h.client.post(f"{link}/ack")
    res = h.client.post(f"{link}/unlock", follow_redirects=False)
    assert res.headers["location"].endswith("done=unlock_not_allowed")
    h.client.post(f"/api/lifeline/alerts/{h.alert()['id']}/resolve")
    h.settings(home=current["home"])
    h.help(test=True)
    test_link = h.link("jordan", h.alert())
    h.client.post(f"{test_link}/ack")
    res = h.client.post(f"{test_link}/unlock", follow_redirects=False)
    assert res.headers["location"].endswith("done=unlock_test")
    assert device(h, "front_door") == "locked"


def test_lights_turn_on_for_real_alerts_only(h: H) -> None:
    h.help(test=True)
    assert device(h, "hall_light") == "off"
    h.client.post(f"/api/lifeline/alerts/{h.alert()['id']}/resolve")
    activate(h)
    assert device(h, "hall_light") == "on"
    assert "lights_on" in kinds(h.alert())


# -- ventilator power -----------------------------------------------------------------------


def test_a_power_cut_raises_an_alert_while_the_battery_still_has_time(h: H) -> None:
    two_people(h)
    h.client.put("/api/demo/faults", json={"lifeline_power_cut": True})
    h.tick(5)
    alert = h.alert()
    assert alert["kind"] == "power_lost"
    assert alert["status"] == "active", "no countdown: the person may not know"
    assert alert["urgency"] == "urgent"
    assert alert["situation"] == "equipment"
    assert "about 45 minutes left" in alert["detail"]
    assert alerts_to(alert) == ["jordan"]
    body = h.client.get("/api/lifeline/outbox").json()["messages"][0]["body"]
    assert "Riley's ventilator lost mains power" in body and "about 45 minutes left" in body
    status = h.status()
    assert status["home"]["state"]["power"]["mains"] is False

    # The battery runs down: below 20 minutes the alert becomes critical and everyone is told.
    for _ in range(26):
        h.tick(60)
    alert = h.alert()
    assert alert["urgency"] == "critical"
    assert "power_low" in kinds(alert)

    h.client.put("/api/demo/faults", json={"lifeline_power_cut": False})
    h.tick(5)
    alert = h.alert()
    assert "power_back" in kinds(alert)
    assert alert["status"] in ("active", "acknowledged"), "power coming back doesn't end the alert; a person checks"


def test_a_power_cut_during_an_open_alert_is_added_to_it(h: H) -> None:
    activate(h)
    h.client.put("/api/demo/faults", json={"lifeline_power_cut": True})
    h.tick(5)
    alerts = h.client.get("/api/lifeline/alerts").json()
    assert len(alerts) == 1
    alert = h.alert()
    assert "power_lost" in kinds(alert)
    assert alert["situation"] == "equipment"
    assert "about 45 minutes left" in (alert["detail"] or "")


def test_power_watch_can_be_turned_off(h: H) -> None:
    current = h.client.get("/api/lifeline/settings").json()
    h.settings(home={**current["home"], "watch_power": False})
    h.client.put("/api/demo/faults", json={"lifeline_power_cut": True})
    h.tick(60)
    assert h.status()["open_alert"] is None


# -- paramedics -----------------------------------------------------------------------------


def test_the_paramedic_summary_has_only_recorded_facts(h: H) -> None:
    activate(h)
    situation(h, "breathing")
    link = h.link("jordan")
    h.client.post(f"{link}/ask/breathing")
    qid = h.alert()["pending_question"]["id"]
    h.client.post(f"/api/lifeline/questions/{qid}/answer", json={"answer": "yes"})
    h.client.post(f"{link}/step/1")
    summary = {item["label"]: item["text"] for item in h.alert()["handoff"]}
    assert summary["Communication"].startswith("Can't speak")
    assert summary["Riley said"] == "Breathing or mask"
    assert "Is it your breathing? Yes" in summary["Riley's answers"]
    assert "Re-seat it" in summary["Done so far"] and "Jordan" in summary["Done so far"]
    assert summary["Allergies"] == "Penicillin (demo)."
    assert "Emergency services" not in summary
    page = h.client.get(link).text
    assert "For paramedics: show them this" in page


# -- providers and upgrades -------------------------------------------------------------


def test_home_assistant_reads_power_turns_on_lights_and_never_unlocks(h: H) -> None:
    calls: list[tuple[str, str, Any]] = []
    states = {"binary_sensor.vent_mains": "off", "sensor.vent_battery": "33"}

    def transport(method: str, url: str, headers: dict[str, str], body: Any) -> tuple[int, Any]:
        calls.append((method, url, body))
        assert headers["Authorization"] == "Bearer secret"
        if method == "GET":
            entity = url.rsplit("/", 1)[1]
            return 200, {"entity_id": entity, "state": states[entity], "attributes": {}}
        return 200, []

    home = HomeAssistantHome(
        "http://ha.local:8123/",
        "secret",
        lights_entity="light.hall",
        power_entity="binary_sensor.vent_mains",
        battery_entity="sensor.vent_battery",
        transport=transport,
    )
    power = h.run(home.power)
    assert power.mains is False and power.battery_minutes == 33.0
    assert h.run(home.lights_on).ok
    assert calls[-1] == ("POST", "http://ha.local:8123/api/services/light/turn_on", {"entity_id": "light.hall"})
    before = len(calls)
    result = h.run(home.unlock)
    assert result.ok is False and "isn't enabled" in (result.error or "")
    assert len(calls) == before, "no request is ever made to unlock a real door"
    assert home.has_lock is False


def test_an_older_database_gets_the_rescue_defaults(h: H) -> None:
    db = h.svc.db
    settings = db.get_state("lifeline_settings")
    old = {k: v for k, v in settings.items() if k not in ("plans", "plans_note", "dispatch", "home", "critical_alert_everyone")}
    db.set_state("lifeline_settings", old)
    db.execute("DELETE FROM svc_home_devices")
    ensure_seeded(db)
    upgraded = db.get_state("lifeline_settings")
    assert upgraded["plans"]["breathing"]
    assert upgraded["dispatch"]["consent"] is True
    assert db.query_one("SELECT COUNT(*) AS n FROM svc_home_devices")["n"] == 3


def test_emergency_services_permission_is_separate_and_timestamped_by_the_coordinator(h: H) -> None:
    current = h.client.get("/api/lifeline/settings").json()
    off = h.settings(dispatch={**current["dispatch"], "consent": False, "consented_at": "2000-01-01T00:00:00Z"})
    assert off["dispatch"]["consented_at"] is None
    assert off["consent"] is True, "contacting people and requesting emergency services are separate permissions"
    h.clock.advance(30)
    on = h.settings(dispatch={**off["dispatch"], "consent": True, "consented_at": "2000-01-01T00:00:00Z"})
    assert on["dispatch"]["consented_at"] == "2026-10-10T10:00:30.000Z"
    bad = {**on["dispatch"], "phone": "555"}
    assert h.client.put("/api/lifeline/settings", json={**on, "dispatch": bad}).status_code == 422
