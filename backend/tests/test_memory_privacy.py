"""Privacy and control: secrets refused, private mode, caregiver consent, opt-in summaries, encryption."""

from __future__ import annotations

import sqlite3
import subprocess
import sys
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from memory_fixtures import FRIDAY_EVENING, choose, make_service, memory_client

from agency.memory import FakeClock, MemoryService, MemoryServiceError
from agency.memory.crypto import PREFIX, KeychainKeyStore, NullCipher
from agency.memory.models import GrantRequest, NodePatch, SelectionEventIn, looks_like_card_number

DINNER = ["food", "delivery", "Thai Basil", "Pad thai (mild)"]
PHARMACY = ["call", "Pharmacy"]


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(FRIDAY_EVENING)


@pytest.fixture
def svc(tmp_path: Path, clock: FakeClock) -> MemoryService:
    return make_service(tmp_path, clock)


# -- never store secrets -------------------------------------------------------------------
def test_secret_details_are_dropped_and_card_numbers_refused(svc: MemoryService) -> None:
    result = choose(svc, DINNER, password="hunter2", otp="123456", card_number="4111 1111 1111 1111", spice="mild")
    assert result["stored"] and sorted(result["dropped"]) == ["card_number", "otp", "password"]
    leaf = next(n for n in svc.tree() if n["label"] == "Pad thai (mild)")
    assert leaf["attributes"] == {"spice": "mild"}
    raw = svc.store.raw_events()[0]["attributes"]
    assert raw == {"spice": "mild"}
    # A card number in any detail value is dropped even under an innocent name.
    assert choose(svc, DINNER, note="4111-1111-1111-1111")["dropped"] == ["note"]
    with pytest.raises(ValueError):
        SelectionEventIn(path=["shopping", "4111 1111 1111 1111"], surface="shopping", outcome="chosen")
    assert looks_like_card_number("4111 1111 1111 1111")
    assert not looks_like_card_number("Order 4111 1111 1111 1111 please")
    assert not looks_like_card_number("1234 5678 9012 3456")  # fails Luhn


# -- sensitive items and private mode ------------------------------------------------------
def test_health_money_and_relationships_are_marked_sensitive(svc: MemoryService) -> None:
    choose(svc, PHARMACY, surface="call")
    choose(svc, ["papers", "Bank statement"], surface="papers")
    choose(svc, ["talk", "I love you"], surface="talk", sensitive="true")
    choose(svc, DINNER)
    flags = {n["label"]: n["sensitive"] for n in svc.tree()}
    assert flags["Pharmacy"] and flags["Bank statement"] and flags["I love you"]
    assert not flags["Pad thai (mild)"] and not flags["food"]


def test_private_mode_keeps_sensitive_things_off_screen(svc: MemoryService) -> None:
    choose(svc, PHARMACY, surface="call")
    choose(svc, ["call", "Jordan"], surface="call")
    svc.save_settings(svc.settings().model_copy(update={"private_mode": True}))
    assert [s["label"] for s in svc.suggestions("call")] == ["Jordan"]
    assert [s["label"] for s in svc.suggestions("home")] == ["Jordan"]
    tree = {n["id"]: n for n in svc.tree()}
    masked = [n for n in tree.values() if n.get("masked")]
    assert len(masked) == 1 and masked[0]["label"] == "Private" and masked[0]["attributes"] == {}
    assert svc.node_detail(masked[0]["id"])["label"] == "Private"
    revealed = {n["label"] for n in svc.tree(reveal=True)}
    assert "Pharmacy" in revealed
    # Children inherit: a sensitive area hides everything under it.
    choose(svc, ["Health", "Physio", "Tuesday stretch"], surface="home")
    assert all(s["path"][0] != "Health" for s in svc.suggestions("home"))
    svc.save_settings(svc.settings().model_copy(update={"private_mode": False}))
    assert {s["label"] for s in svc.suggestions("call")} == {"Jordan", "Pharmacy"}


def test_the_person_can_change_the_sensitive_flag(svc: MemoryService) -> None:
    choose(svc, DINNER)
    leaf = next(n for n in svc.tree() if n["label"] == "Pad thai (mild)")
    svc.patch(leaf["id"], NodePatch(sensitive=True))
    svc.save_settings(svc.settings().model_copy(update={"private_mode": True}))
    assert svc.suggestions("food") == []


# -- caregiver access only with consent ----------------------------------------------------
def test_caregiver_access_needs_consent_respects_scope_expires_and_is_logged(svc: MemoryService, clock: FakeClock) -> None:
    choose(svc, DINNER)
    choose(svc, PHARMACY, surface="call")
    with pytest.raises(MemoryServiceError):
        svc.grant(GrantRequest(caregiver="Sam", confirm=False))
    grant = svc.grant(GrantRequest(caregiver="Sam", scope="everyday", days=7, confirm=True))
    token = grant.pop("token")
    assert "token" not in str(svc.store.grants())
    view = svc.caregiver_view(token)
    labels = {n["label"] for n in view["nodes"]}
    assert "Pad thai (mild)" in labels and "Pharmacy" not in labels
    assert svc.store.access_log()[0]["caregiver"] == "Sam"
    with pytest.raises(MemoryServiceError):
        svc.caregiver_view("not-a-token")
    clock.advance(days=8)
    with pytest.raises(MemoryServiceError):
        svc.caregiver_view(token)
    everything = svc.grant(GrantRequest(caregiver="Dr Lee", scope="everything", confirm=True))
    assert "Pharmacy" in {n["label"] for n in svc.caregiver_view(everything["token"])["nodes"]}
    svc.revoke(everything["id"])
    with pytest.raises(MemoryServiceError):
        svc.caregiver_view(everything["token"])
    svc.forget_all(True)
    assert svc.store.grants() == []


def test_caregiver_route_uses_a_grant_header(tmp_path: Path, clock: FakeClock) -> None:
    with memory_client(tmp_path, clock) as client:
        client.post("/api/memory/events", json={"path": DINNER, "surface": "food", "outcome": "chosen"})
        assert client.post("/api/memory/grants", json={"caregiver": "Sam"}).status_code == 422
        grant = client.post("/api/memory/grants", json={"caregiver": "Sam", "confirm": True}).json()
        assert client.get("/api/memory/caregiver").status_code == 403
        view = client.get("/api/memory/caregiver", headers={"X-Memory-Grant": grant["token"]})
        assert view.status_code == 200 and view.json()["caregiver"] == "Sam"
        assert client.delete(f"/api/memory/grants/{grant['id']}").status_code == 200
        assert client.get("/api/memory/caregiver", headers={"X-Memory-Grant": grant["token"]}).status_code == 403


# -- opt-in summaries: exactly what would be sent ------------------------------------------
class FakeSummarizer:
    def __init__(self) -> None:
        self.sent: list[list[str]] = []

    async def __call__(self, facts: list[str]) -> list[str]:
        self.sent.append(list(facts))
        return ["You like Thai food on Friday evenings.", ""]


@pytest.fixture
def summary_client(tmp_path: Path, clock: FakeClock) -> Iterator[tuple[TestClient, FakeSummarizer]]:
    fake = FakeSummarizer()
    with memory_client(tmp_path, clock, memory_summarizer=fake, memory_summarizer_model="test-model") as c:
        c.put("/api/memory/settings", json={"timezone": "America/New_York"})
        for weeks in (3, 2, 1):
            clock.set(FRIDAY_EVENING - timedelta(weeks=weeks))
            c.post("/api/memory/events", json={"path": DINNER, "surface": "food", "outcome": "chosen"})
            c.post("/api/memory/events", json={"path": PHARMACY, "surface": "call", "outcome": "chosen"})
        clock.set(FRIDAY_EVENING)
        yield c, fake


def test_summary_preview_shows_exactly_what_is_sent_and_excludes_sensitive(
    summary_client: tuple[TestClient, FakeSummarizer],
) -> None:
    client, fake = summary_client
    preview = client.get("/api/memory/summary/preview").json()
    assert preview["enabled"] is False and preview["destination"] == "Anthropic API (test-model)"
    assert len(preview["facts"]) == 1 and preview["facts"][0].startswith("food > delivery > Thai Basil > Pad thai (mild)")
    assert all("Pharmacy" not in f for f in preview["facts"])
    # Off by default: nothing is sent.
    assert client.post("/api/memory/summary", json={"factsHash": preview["factsHash"]}).status_code == 409
    assert fake.sent == []
    settings = client.get("/api/memory/settings").json()
    client.put("/api/memory/settings", json={**settings, "summariesEnabled": True})
    # A hash that doesn't match the current facts is refused.
    assert client.post("/api/memory/summary", json={"factsHash": "0" * 64}).status_code == 409
    res = client.post("/api/memory/summary", json={"factsHash": preview["factsHash"]})
    assert res.status_code == 200
    assert fake.sent == [preview["facts"]]
    notes = client.get("/api/memory/notes").json()
    assert [n["text"] for n in notes] == ["You like Thai food on Friday evenings."]
    assert client.delete(f"/api/memory/notes/{notes[0]['id']}").status_code == 200
    assert client.get("/api/memory/notes").json() == []


def test_summary_without_a_model_sends_nothing(tmp_path: Path, clock: FakeClock) -> None:
    with memory_client(tmp_path, clock) as client:
        preview = client.get("/api/memory/summary/preview").json()
        assert preview["available"] is False
        settings = client.get("/api/memory/settings").json()
        client.put("/api/memory/settings", json={**settings, "summariesEnabled": True})
        res = client.post("/api/memory/summary", json={"factsHash": preview["factsHash"]})
        assert res.status_code == 409 and "No cloud model" in res.json()["detail"]


# -- encryption at rest --------------------------------------------------------------------
class FakeKeystore(KeychainKeyStore):
    def __init__(self) -> None:
        super().__init__()
        self.key: bytes | None = None

    def load(self) -> bytes | None:
        return self.key

    def load_or_create(self) -> bytes:
        if self.key is None:
            self.key = b"k" * 32
        return self.key


def raw_text(db_path: Path) -> str:
    conn = sqlite3.connect(db_path)
    try:
        return "\n".join(
            str(row) for table in ("memory_nodes", "memory_events") for row in conn.execute(f"SELECT * FROM {table}")
        )
    finally:
        conn.close()


def test_encryption_at_rest_round_trip(tmp_path: Path, clock: FakeClock) -> None:
    pytest.importorskip("cryptography")
    keystore = FakeKeystore()
    svc = make_service(tmp_path, clock, keystore=keystore)
    choose(svc, DINNER, spice="mild")
    assert "Thai Basil" in raw_text(tmp_path / "memory.db")
    status = svc.set_encryption(True)
    assert status["enabled"] and status["keyStore"] == "macOS keychain"
    raw = raw_text(tmp_path / "memory.db")
    assert "Thai Basil" not in raw and "mild" not in raw and PREFIX in raw
    # Still works, and new events are encrypted too.
    choose(svc, DINNER, spice="mild")
    choose(svc, ["talk", "Good morning"], surface="talk")
    assert "Good morning" not in raw_text(tmp_path / "memory.db")
    assert svc.suggestions("food")[0]["label"] == "Pad thai (mild)"
    # A new process with the key in the keychain reads it back.
    again = MemoryService(svc.db, clock, keystore=keystore)
    assert {n["label"] for n in again.tree()} >= set(DINNER)
    # Without the key, the memory is locked rather than silently empty.
    locked = MemoryService(svc.db, clock, keystore=FakeKeystore())
    with pytest.raises(MemoryServiceError) as err:
        locked.tree()
    assert err.value.status == 503
    # Turning it off decrypts in place.
    svc.set_encryption(False)
    assert "Thai Basil" in raw_text(tmp_path / "memory.db")
    assert {n["label"] for n in svc.tree()} >= set(DINNER)


def test_reencrypt_plumbing_with_a_toy_cipher(svc: MemoryService) -> None:
    """Runs without the cryptography package: the store rewrites every text field and the blind index."""

    class Rot(NullCipher):
        @property
        def enabled(self) -> bool:
            return True

        def index_key(self) -> bytes:
            return b"other-key"

        def encrypt(self, plaintext: str) -> str:
            return PREFIX + plaintext[::-1]

        def decrypt(self, stored: str) -> str:
            return stored[len(PREFIX) :][::-1] if stored.startswith(PREFIX) else stored

    choose(svc, DINNER, spice="mild")
    svc.store.reencrypt(Rot(b"x"))
    labels = [r["label"] for r in svc.db.query("SELECT label FROM memory_nodes")]
    assert all(label.startswith(PREFIX) for label in labels)
    assert svc.resolve(["food", "delivery"]) is not None  # blind index rebuilt for the new key
    choose(svc, DINNER)
    assert len(svc.tree()) == 4


@pytest.mark.skipif(sys.platform != "darwin", reason="the macOS keychain exists only on macOS")
def test_real_keychain_with_a_throwaway_keychain_file(tmp_path: Path) -> None:
    keychain = tmp_path / "agency-test.keychain-db"
    subprocess.run(["/usr/bin/security", "create-keychain", "-p", "test", str(keychain)], check=True)
    try:
        subprocess.run(["/usr/bin/security", "unlock-keychain", "-p", "test", str(keychain)], check=True)
        store = KeychainKeyStore(keychain=keychain, service="AGENCY Memory Test")
        assert store.load() is None
        key = store.load_or_create()
        assert len(key) == 32 and store.load() == key and store.load_or_create() == key
        store.delete()
        assert store.load() is None
    finally:
        subprocess.run(["/usr/bin/security", "delete-keychain", str(keychain)], check=False)


def test_export_contains_everything_the_person_owns(svc: MemoryService) -> None:
    choose(svc, DINNER, spice="mild")
    svc.grant(GrantRequest(caregiver="Sam", confirm=True))
    data: dict[str, Any] = svc.export()
    assert {"nodes", "events", "notes", "settings", "caregiverAccess", "accessLog"} <= set(data)
    assert all("token" not in g for g in data["caregiverAccess"])
    assert data["events"][0]["attributes"] == {"spice": "mild"}
