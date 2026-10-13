"""The caregiver's phone companion: pairing, security, setup from a phone, staying close, hand-over notes.

The phone server is driven in-process with a TestClient that says it comes from a home-network address, except in
the listener tests, which open a real port on 127.0.0.1.
"""

from __future__ import annotations

import base64
import socket
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from agency.companion.config import CompanionConfig, load_config
from agency.companion.runtime import CompanionRuntime
from agency.companion.security import RateLimiter, host_allowed, is_home_address
from agency.companion.server import CompanionListener
from conftest import make_client

PHONE_BASE = "http://192.168.1.5:8470"
PHONE_ADDR = ("192.168.1.20", 50000)
TINY_JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0fake-jpeg-bytes\xff\xd9").decode()


@dataclass
class C:
    mac: TestClient
    rt: CompanionRuntime

    def phone(self, *, addr: tuple[str, int] = PHONE_ADDR, base: str = PHONE_BASE, token: str | None = None) -> TestClient:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return TestClient(self.rt.app, base_url=base, client=addr, headers=headers)

    def enable(self) -> None:
        res = self.mac.post("/api/companion/enabled", json={"enabled": True})
        assert res.status_code == 200, res.text
        assert res.json()["enabled"] is True

    def code(self) -> str:
        res = self.mac.post("/api/companion/pair")
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["link"].endswith(f"/#pair={body['code']}")
        return str(body["code"])

    def pair(self, name: str = "Jordan", contact_id: str | None = "jordan") -> tuple[str, dict[str, Any]]:
        res = self.phone().post("/phone/api/pair", json={"code": self.code(), "name": name, "contact_id": contact_id})
        assert res.status_code == 200, res.text
        return res.json()["token"], res.json()["device"]

    def lifeline(self) -> dict[str, Any]:
        out: dict[str, Any] = self.mac.get("/api/lifeline/settings").json()
        return out


@pytest.fixture
def c(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[C]:
    monkeypatch.setenv("AGENCY_COMPANION_LISTEN", "0")
    with make_client(tmp_path) as mac:
        yield C(mac, mac.app.state.agency.companion)  # type: ignore[attr-defined]


# -- pairing ----------------------------------------------------------------------------


def test_pairing_with_the_code_on_the_mac_gives_the_phone_its_own_token(c: C) -> None:
    c.enable()
    token, device = c.pair()
    assert device["name"] == "Jordan" and device["contact_name"] == "Jordan"
    me = c.phone(token=token).get("/phone/api/me")
    assert me.status_code == 200 and me.json()["id"] == device["id"]
    # The Mac sees the phone, and the log says it was paired.
    status = c.mac.get("/api/companion/status").json()
    assert [d["name"] for d in status["devices"]] == ["Jordan"]
    assert any("Jordan's phone was paired" in ch["summary"] for ch in c.mac.get("/api/companion/changes").json())
    # Only a hash of the token is stored.
    rows = c.rt.service.db.query("SELECT token_hash FROM companion_devices")
    assert rows[0]["token_hash"] != token and len(rows[0]["token_hash"]) == 64


def test_a_code_works_once(c: C) -> None:
    c.enable()
    code = c.code()
    assert c.phone().post("/phone/api/pair", json={"code": code, "name": "Jordan"}).status_code == 200
    again = c.phone().post("/phone/api/pair", json={"code": code, "name": "Mallory"})
    assert again.status_code == 403
    assert len(c.rt.service.devices()) == 1


def test_a_code_expires_after_five_minutes(c: C) -> None:
    c.enable()
    code = c.code()
    real_now = c.rt.service.now
    c.rt.service.now = lambda: real_now() + timedelta(seconds=301)
    res = c.phone().post("/phone/api/pair", json={"code": code, "name": "Jordan"})
    assert res.status_code == 403 and "no pairing code" in res.json()["detail"]


def test_five_wrong_codes_cancel_the_code(c: C) -> None:
    c.enable()
    code = c.code()
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"
    for i in range(5):
        res = c.phone().post("/phone/api/pair", json={"code": wrong, "name": "Mallory"})
        assert res.status_code == 403
        assert ("cancelled" in res.json()["detail"]) == (i == 4)
    # Even the right code is now refused.
    assert c.phone().post("/phone/api/pair", json={"code": code, "name": "Jordan"}).status_code == 403


def test_a_new_code_retires_the_old_one(c: C) -> None:
    c.enable()
    first = c.code()
    second = c.code()
    if first != second:
        assert c.phone().post("/phone/api/pair", json={"code": first, "name": "Jordan"}).status_code == 403
    assert c.phone().post("/phone/api/pair", json={"code": second, "name": "Jordan"}).status_code == 200


def test_pairing_needs_the_companion_turned_on(c: C) -> None:
    res = c.mac.post("/api/companion/pair")
    assert res.status_code == 409 and "Turn on" in res.json()["detail"]
    # While off, the phone server answers nothing at all.
    assert c.phone().post("/phone/api/pair", json={"code": "123456", "name": "Jordan"}).status_code == 503
    assert c.phone().get("/").status_code == 503


def test_pairing_is_rate_limited_per_address(c: C) -> None:
    c.enable()
    c.code()
    codes = [f"{n:06d}" for n in range(11)]
    statuses = []
    for code in codes:
        # A fresh code every few tries so the five-try burn doesn't hide the rate limit.
        if len(statuses) % 4 == 3:
            c.rt.service.start_pairing()
        statuses.append(c.phone().post("/phone/api/pair", json={"code": code, "name": "Mallory"}).status_code)
    assert statuses[:10].count(429) == 0
    assert statuses[10] == 429
    # Another address on the home network isn't blocked by it.
    other = c.phone(addr=("192.168.1.30", 50000)).post("/phone/api/pair", json={"code": "000000", "name": "Jordan"})
    assert other.status_code != 429


# -- refusals ---------------------------------------------------------------------------


PHONE_ROUTES = [
    ("get", "/phone/api/me", None),
    ("get", "/phone/api/home", None),
    ("get", "/phone/api/setup", None),
    ("put", "/phone/api/setup/phrases", {"phrases": ["Hello"]}),
    ("get", "/phone/api/notes", None),
    ("post", "/phone/api/notes", {"text": "Hello"}),
    ("get", "/phone/api/messages", None),
    ("post", "/phone/api/messages", {"text": "Hello"}),
    ("post", "/phone/api/me/link", {"contact_id": "jordan"}),
    ("post", "/phone/api/me/forget", {}),
]


@pytest.mark.parametrize(("method", "path", "body"), PHONE_ROUTES)
def test_unpaired_phones_can_see_and_change_nothing(c: C, method: str, path: str, body: Any) -> None:
    c.enable()
    for token in (None, "made-up-token", "x" * 200):
        phone = c.phone(token=token)
        res = getattr(phone, method)(path, json=body) if body is not None else getattr(phone, method)(path)
        assert res.status_code == 401, (path, token, res.text)
        assert "isn't paired" in res.json()["detail"]
        assert "Riley" not in res.text


@pytest.mark.parametrize(("method", "path", "body"), PHONE_ROUTES)
def test_a_removed_phone_is_refused(c: C, method: str, path: str, body: Any) -> None:
    c.enable()
    token, device = c.pair()
    assert c.mac.delete(f"/api/companion/devices/{device['id']}").status_code == 200
    phone = c.phone(token=token)
    res = getattr(phone, method)(path, json=body) if body is not None else getattr(phone, method)(path)
    assert res.status_code == 401
    assert c.mac.get("/api/companion/status").json()["devices"] == []


def test_turning_the_companion_off_locks_every_phone_out(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    c.mac.post("/api/companion/enabled", json={"enabled": False})
    assert c.phone(token=token).get("/phone/api/home").status_code == 503
    # Turned back on, the phone is still paired (removing it is a separate, deliberate step).
    c.enable()
    assert c.phone(token=token).get("/phone/api/home").status_code == 200


def test_a_phone_can_unpair_itself(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    assert c.phone(token=token).post("/phone/api/me/forget", json={}).status_code == 200
    assert c.phone(token=token).get("/phone/api/me").status_code == 401


def test_the_phone_server_refuses_addresses_outside_the_home_network(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    for addr in ("8.8.8.8", "100.100.1.1", "2001:4860::8888", "testclient"):
        res = c.phone(addr=(addr, 50000), token=token).get("/phone/api/home")
        assert res.status_code == 403, addr
        assert "home network" in res.text


def test_the_phone_server_refuses_other_sites_host_names(c: C) -> None:
    """DNS rebinding: a web page can't point its own domain at the Mac and talk to the companion."""
    c.enable()
    token, _ = c.pair()
    assert c.phone(base="http://evil.example:8470", token=token).get("/phone/api/home").status_code == 421
    assert c.phone(base="http://riley-mac.local:8470", token=token).get("/phone/api/home").status_code == 200


def test_the_phone_server_has_no_route_into_the_coordinator_api(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    for path in ("/api/lifeline/settings", "/api/companion/status", "/api/health", "/api/demo/reset"):
        assert c.phone(token=token).get(path).status_code == 404, path
    assert c.phone(token=token).post("/api/companion/pair").status_code == 404


def test_the_mac_side_needs_the_coordinator_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENCY_COMPANION_LISTEN", "0")
    with make_client(tmp_path, token="s3cret") as mac:
        assert mac.get("/api/companion/status").status_code == 401
        assert mac.post("/api/companion/enabled", json={"enabled": True}).status_code == 401
        ok = mac.get("/api/companion/status", headers={"X-Agency-Token": "s3cret"})
        assert ok.status_code == 200


def test_oversized_requests_are_refused(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    big = "data:image/jpeg;base64," + "A" * 2_100_000
    res = c.phone(token=token).post("/phone/api/messages", json={"text": "hi", "photo": big})
    assert res.status_code == 413


def test_phone_pages_carry_strict_headers(c: C) -> None:
    c.enable()
    res = c.phone().get("/phone/api/home")
    assert res.headers["Referrer-Policy"] == "no-referrer"
    assert res.headers["X-Frame-Options"] == "DENY"
    assert res.headers["Cache-Control"] == "no-store"
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers}


# -- setting up from the phone -------------------------------------------------------------


def contacts_with(c: C, *extra: dict[str, Any], drop: str | None = None) -> list[dict[str, Any]]:
    contacts = [x for x in c.lifeline()["contacts"] if x["id"] != drop]
    return contacts + list(extra)


def test_adding_a_simulated_contact_applies_at_once_and_is_logged(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    sam = {"id": "sam", "name": "Sam", "role": "family", "channel": "demo", "priority": 2, "enabled": True, "address": ""}
    res = c.phone(token=token).put("/phone/api/setup/contacts", json={"contacts": contacts_with(c, sam)})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "applied"
    assert "added Sam" in res.json()["summary"]
    assert "sam" in [x["id"] for x in c.lifeline()["contacts"]]
    log = c.mac.get("/api/companion/changes").json()
    assert log[0]["author"] == "Jordan" and log[0]["kind"] == "contacts"


def test_a_real_phone_number_waits_for_the_person(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    sam = {
        "id": "sam",
        "name": "Sam",
        "role": "family",
        "channel": "sms",
        "address": "+14155550123",
        "priority": 2,
        "enabled": True,
    }
    res = c.phone(token=token).put("/phone/api/setup/contacts", json={"contacts": contacts_with(c, sam)})
    assert res.json()["status"] == "waiting_person"
    assert "sam" not in [x["id"] for x in c.lifeline()["contacts"]]
    waiting = c.mac.get("/api/companion/status").json()["waiting_for_person"]
    assert [w["id"] for w in waiting] == [res.json()["id"]]
    # The person allows it on their screen.
    allowed = c.mac.post(f"/api/companion/changes/{res.json()['id']}/decision", json={"allow": True})
    assert allowed.json()["status"] == "applied"
    assert "sam" in [x["id"] for x in c.lifeline()["contacts"]]
    # It can't be decided twice.
    assert c.mac.post(f"/api/companion/changes/{res.json()['id']}/decision", json={"allow": False}).status_code == 409


def test_removing_a_contact_waits_and_can_be_turned_down(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    res = c.phone(token=token).put("/phone/api/setup/contacts", json={"contacts": contacts_with(c, drop="morgan")})
    assert res.json()["status"] == "waiting_person" and "removed Morgan" in res.json()["summary"]
    no = c.mac.post(f"/api/companion/changes/{res.json()['id']}/decision", json={"allow": False})
    assert no.json()["status"] == "declined"
    assert "morgan" in [x["id"] for x in c.lifeline()["contacts"]]
    # The phone sees it was turned down.
    assert c.phone(token=token).get("/phone/api/setup").json()["open"] == []


def test_invalid_contacts_are_refused(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    bad = {"id": "sam", "name": "Sam", "channel": "sms", "address": "555-1234"}
    res = c.phone(token=token).put("/phone/api/setup/contacts", json={"contacts": contacts_with(c, bad)})
    assert res.status_code == 422
    unknown = c.phone(token=token).put("/phone/api/setup/consent", json={"consent": False})
    assert unknown.status_code == 404


def test_safer_settings_apply_at_once_and_weaker_ones_wait(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    phone = c.phone(token=token)
    safety = phone.get("/phone/api/setup").json()["safety"]
    assert safety["watch"] is False
    on = phone.put("/phone/api/setup/safety", json=safety | {"watch": True, "checkin_interval_min": 60})
    assert on.json()["status"] == "applied"
    assert c.mac.get("/api/lifeline/status").json()["monitor"]["armed"] is True
    assert c.lifeline()["checkin_interval_min"] == 60
    off = phone.put("/phone/api/setup/safety", json=safety | {"watch": False, "checkin_interval_min": 60})
    assert off.json()["status"] == "waiting_person"
    assert c.mac.get("/api/lifeline/status").json()["monitor"]["armed"] is True
    c.mac.post(f"/api/companion/changes/{off.json()['id']}/decision", json={"allow": True})
    assert c.mac.get("/api/lifeline/status").json()["monitor"]["armed"] is False
    # Nothing changed: nothing logged.
    same = phone.put("/phone/api/setup/safety", json=phone.get("/phone/api/setup").json()["safety"])
    assert same.json()["status"] == "unchanged"


def test_changes_kept_on_the_mac_wait_for_the_mac_and_are_reported_back(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    phone = c.phone(token=token)
    res = phone.put("/phone/api/setup/phrases", json={"phrases": ["Please turn me", "Please turn me", " Water\n please "]})
    assert res.json()["status"] == "waiting_mac"
    opened = c.mac.get("/api/companion/open").json()
    assert opened[0]["payload"] == {"phrases": ["Please turn me", "Water please"]}
    done = c.mac.post(f"/api/companion/changes/{res.json()['id']}/applied", json={"ok": True})
    assert done.json()["status"] == "applied"
    assert c.mac.get("/api/companion/open").json() == []


def test_a_newer_change_replaces_one_not_yet_applied(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    phone = c.phone(token=token)
    first = phone.put("/phone/api/setup/favourites", json={"favourites": [{"title": "BBC", "url": "bbc.co.uk"}]})
    second = phone.put("/phone/api/setup/favourites", json={"favourites": [{"title": "News", "url": "https://apnews.com"}]})
    opened = c.mac.get("/api/companion/open").json()
    assert [o["id"] for o in opened] == [second.json()["id"]]
    assert opened[0]["payload"]["favourites"] == [{"title": "News", "url": "https://apnews.com"}]
    assert c.rt.service.change(first.json()["id"])["status"] == "replaced"


def test_a_bad_web_address_is_refused(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    res = c.phone(token=token).put(
        "/phone/api/setup/favourites", json={"favourites": [{"title": "x", "url": "javascript:alert(1)"}]}
    )
    assert res.status_code == 422


def test_details_are_erased_from_the_coordinator_once_applied(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    details = {"fullName": "Riley Example", "dateOfBirth": "01/02/1960", "city": "Santa Cruz"}
    res = c.phone(token=token).put("/phone/api/setup/details", json={"details": details})
    assert res.json()["status"] == "waiting_mac" and "3 boxes" in res.json()["summary"]
    assert c.mac.get("/api/companion/open").json()[0]["payload"]["details"]["fullName"] == "Riley Example"
    c.mac.post(f"/api/companion/changes/{res.json()['id']}/applied", json={"ok": True})
    row = c.rt.service.db.query_one("SELECT payload FROM companion_changes WHERE id = ?", (res.json()["id"],))
    assert row is not None and row["payload"] == "{}"


def test_a_failure_on_the_mac_is_reported(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    res = c.phone(token=token).put("/phone/api/setup/papers_folder", json={"folder": "downloads"})
    c.mac.post(f"/api/companion/changes/{res.json()['id']}/applied", json={"ok": False, "reason": "Needs the Mac app."})
    change = c.rt.service.change(res.json()["id"])
    assert change["status"] == "failed" and change["reason"] == "Needs the Mac app."
    bad = c.phone(token=token).put("/phone/api/setup/papers_folder", json={"folder": "/etc"})
    assert bad.status_code == 422


def test_the_phone_edits_what_the_mac_really_has(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    snap = {
        "phrases": ["Hello"],
        "favourites": [{"title": "BBC", "url": "https://bbc.co.uk"}],
        "papers_folder": None,
        "details": None,
    }
    assert c.mac.put("/api/companion/snapshot", json=snap).status_code == 200
    mac = c.phone(token=token).get("/phone/api/setup").json()["mac"]
    assert mac["known"] and mac["phrases"] == ["Hello"]
    # Turning the companion off drops the copy.
    c.mac.post("/api/companion/enabled", json={"enabled": False})
    assert c.rt.service.snapshot() == {}


# -- staying close ---------------------------------------------------------------------------


def test_home_shows_running_camera_and_battery(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    phone = c.phone(token=token)
    # The demo seed leaves an old heartbeat; move past it so the screen counts as quiet.
    real_now = c.rt.service.now
    c.rt.service.now = lambda: real_now() + timedelta(minutes=5)
    quiet = phone.get("/phone/api/home").json()
    assert quiet["running"] is False and quiet["camera"]["ok"] is False and quiet["battery"]["known"] is False
    c.rt.service.now = real_now
    c.mac.post("/api/lifeline/heartbeat", json={"signal_ready": True, "camera": "on", "face_visible": True})
    c.mac.post("/api/companion/presence", json={"battery_level": 0.82, "charging": True})
    home = phone.get("/phone/api/home").json()
    assert home["running"] is True
    assert home["camera"] == {"state": "on", "ok": True, "face_visible": True, "eye_signal": True}
    assert home["battery"] == {"level": 0.82, "charging": True, "known": True}
    assert home["person"] == "Riley"


def test_the_phone_gets_its_own_alert_link_once_its_person_is_asked(c: C) -> None:
    c.enable()
    jordan, _ = c.pair("Jordan", "jordan")
    morgan, _ = c.pair("Morgan", "morgan")
    c.mac.post("/api/lifeline/help", json={"source": "help_button"})
    alert_id = c.mac.get("/api/lifeline/status").json()["open_alert"]["id"]
    c.mac.post(f"/api/lifeline/alerts/{alert_id}/now")
    home = c.phone(token=jordan).get("/phone/api/home").json()
    assert home["alert"]["status"] == "active"
    path = home["alert"]["respond_path"]
    assert path and path.startswith("/respond/")
    # Morgan is the next level: not asked yet, so no link.
    assert c.phone(token=morgan).get("/phone/api/home").json()["alert"]["respond_path"] is None
    # The response page works through the phone server, and "I'm on my way" reaches Lifeline.
    page = c.phone(token=jordan).get(path)
    assert page.status_code == 200 and "I'm on my way" in page.text
    c.phone(token=jordan).post(f"{path}/ack")
    assert c.mac.get("/api/lifeline/status").json()["open_alert"]["status"] == "acknowledged"
    assert c.phone(token=jordan).get("/phone/api/home").json()["alert"]["acknowledged_by"] == "Jordan"


def test_a_phone_can_link_itself_to_a_lifeline_contact(c: C) -> None:
    c.enable()
    token, device = c.pair("Sam", None)
    assert device["contact_id"] is None
    linked = c.phone(token=token).post("/phone/api/me/link", json={"contact_id": "morgan"})
    assert linked.json()["contact_name"] == "Morgan"
    assert c.phone(token=token).post("/phone/api/me/link", json={"contact_id": "nobody"}).status_code == 404


def test_messages_and_photos_reach_the_persons_screen(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    phone = c.phone(token=token)
    sent = phone.post("/phone/api/messages", json={"text": "On my way with lunch", "photo": TINY_JPEG})
    assert sent.status_code == 200, sent.text
    inbox = c.mac.get("/api/companion/inbox").json()
    assert inbox[0]["text"] == "On my way with lunch" and inbox[0]["photo"] == TINY_JPEG
    assert inbox[0]["author"] == "Jordan"
    c.mac.post(f"/api/companion/messages/{inbox[0]['id']}/seen")
    assert c.mac.get("/api/companion/inbox").json() == []
    mine = phone.get("/phone/api/messages").json()
    assert mine[0]["seen_at"] is not None and "photo" not in mine[0]


def test_bad_messages_are_refused(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    phone = c.phone(token=token)
    assert phone.post("/phone/api/messages", json={"text": "  "}).status_code == 422
    assert phone.post("/phone/api/messages", json={"photo": "data:text/html;base64,PHNjcmlwdD4="}).status_code == 422
    assert phone.post("/phone/api/messages", json={"text": "x" * 281}).status_code == 422


def test_messages_are_rate_limited_per_phone(c: C) -> None:
    c.enable()
    token, _ = c.pair()
    phone = c.phone(token=token)
    codes = [phone.post("/phone/api/messages", json={"text": f"Hello {i}"}).status_code for i in range(13)]
    assert codes[:12] == [200] * 12 and codes[12] == 429


def test_a_removed_phones_unseen_messages_never_appear(c: C) -> None:
    c.enable()
    token, device = c.pair()
    c.phone(token=token).post("/phone/api/messages", json={"text": "Hello"})
    c.mac.delete(f"/api/companion/devices/{device['id']}")
    assert c.mac.get("/api/companion/inbox").json() == []


# -- hand-over notes ---------------------------------------------------------------------------


def test_hand_over_notes_are_shared_between_carers_and_the_mac(c: C) -> None:
    c.enable()
    jordan, _ = c.pair("Jordan", "jordan")
    morgan, _ = c.pair("Morgan", "morgan")
    c.phone(token=jordan).post("/phone/api/notes", json={"text": "Slept well. Mask refitted at 6.\nNeeds water."})
    c.mac.post("/api/companion/notes", json={"text": "Nurse visit at 2.", "author": ""})
    notes = c.phone(token=morgan).get("/phone/api/notes").json()
    assert [(n["author"], n["text"]) for n in notes] == [
        ("At the Mac", "Nurse visit at 2."),
        ("Jordan", "Slept well. Mask refitted at 6.\nNeeds water."),
    ]
    assert c.phone(token=morgan).post("/phone/api/notes", json={"text": "   "}).status_code == 422


# -- pieces ------------------------------------------------------------------------------------


def test_home_address_rules() -> None:
    for ok in ("127.0.0.1", "10.1.2.3", "172.20.0.4", "192.168.0.9", "::1", "fe80::1", "fd00::5", "::ffff:192.168.1.4"):
        assert is_home_address(ok), ok
    for bad in ("8.8.8.8", "100.64.0.1", "172.32.0.1", "2001:db8::1", "", None, "localhost"):
        assert not is_home_address(bad), bad
    import ipaddress

    assert is_home_address("100.64.0.1", [ipaddress.ip_network("100.64.0.0/10")])


def test_host_rules() -> None:
    assert host_allowed("192.168.1.5:8470") and host_allowed("riley-mac.local:8470") and host_allowed("[fe80::1]:8470")
    assert host_allowed("localhost:8470")
    assert not host_allowed("evil.example") and not host_allowed(None) and not host_allowed("192.168.1.5.nip.io")
    assert host_allowed("agency.home.arpa", "https://agency.home.arpa:8470")


def test_rate_limiter_window() -> None:
    t = [0.0]
    limiter = RateLimiter(2, 10, now=lambda: t[0])
    assert limiter.allow("a") and limiter.allow("a") and not limiter.allow("a")
    assert limiter.retry_after("a") >= 1
    t[0] = 10.5
    assert limiter.allow("a")


def test_config_from_environment() -> None:
    cfg = load_config({"AGENCY_COMPANION_PORT": "9001", "AGENCY_COMPANION_HOST": "127.0.0.1"})
    assert cfg.base_url() == "http://127.0.0.1:9001" and not cfg.tls
    tls = load_config(
        {"AGENCY_COMPANION_TLS_CERT": "c.pem", "AGENCY_COMPANION_TLS_KEY": "k.pem", "AGENCY_COMPANION_HOST": "10.0.0.2"}
    )
    assert tls.base_url() == "https://10.0.0.2:8470"
    assert not load_config({"AGENCY_COMPANION": "off"}).available
    assert load_config({"AGENCY_COMPANION_URL": "https://riley.local:8470/"}).base_url() == "https://riley.local:8470"


def test_turning_on_is_refused_when_the_coordinator_disables_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENCY_COMPANION_LISTEN", "0")
    monkeypatch.setenv("AGENCY_COMPANION", "off")
    with make_client(tmp_path) as mac:
        res = mac.post("/api/companion/enabled", json={"enabled": True})
        assert res.status_code == 403
        assert mac.get("/api/companion/status").json()["available"] is False


# -- the real listener ---------------------------------------------------------------------------


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def test_the_phone_server_listens_only_while_turned_on(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    port = free_port()
    monkeypatch.setenv("AGENCY_COMPANION_HOST", "127.0.0.1")
    monkeypatch.setenv("AGENCY_COMPANION_PORT", str(port))
    url = f"http://127.0.0.1:{port}"
    with make_client(tmp_path) as mac:
        with pytest.raises(httpx.ConnectError):
            httpx.get(f"{url}/phone/api/home", timeout=2)
        status = mac.post("/api/companion/enabled", json={"enabled": True}).json()
        assert status["listening"] is True and status["url"] == url
        res = httpx.get(f"{url}/phone/api/home", timeout=5)
        assert res.status_code == 401
        page = httpx.get(f"{url}/", timeout=5)
        assert page.status_code == 503 and "isn't built" in page.text  # no frontend build in this test
        code = mac.post("/api/companion/pair").json()["code"]
        paired = httpx.post(f"{url}/phone/api/pair", json={"code": code, "name": "Jordan"}, timeout=5)
        assert paired.status_code == 200
        mac.post("/api/companion/enabled", json={"enabled": False})
        with pytest.raises(httpx.ConnectError):
            httpx.get(f"{url}/phone/api/home", timeout=2)


def test_a_taken_port_is_reported_not_hidden(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        port = blocker.getsockname()[1]
        monkeypatch.setenv("AGENCY_COMPANION_HOST", "127.0.0.1")
        monkeypatch.setenv("AGENCY_COMPANION_PORT", str(port))
        with make_client(tmp_path) as mac:
            res = mac.post("/api/companion/enabled", json={"enabled": True})
            assert res.status_code == 503 and str(port) in res.json()["detail"]
            assert mac.get("/api/companion/status").json()["enabled"] is False


def test_the_listener_comes_back_after_a_restart(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    port = free_port()
    monkeypatch.setenv("AGENCY_COMPANION_HOST", "127.0.0.1")
    monkeypatch.setenv("AGENCY_COMPANION_PORT", str(port))
    with make_client(tmp_path) as mac:
        mac.post("/api/companion/enabled", json={"enabled": True})
    with make_client(tmp_path) as mac:
        assert mac.get("/api/companion/status").json()["listening"] is True
        assert httpx.get(f"http://127.0.0.1:{port}/phone/api/me", timeout=5).status_code == 401


def test_listener_stop_is_safe_when_never_started() -> None:
    import asyncio

    asyncio.run(CompanionListener(CompanionConfig(host="127.0.0.1", port=free_port())).stop())
