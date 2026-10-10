"""The memory service over SQLite, with a fake clock: tree building, surfaces, usuals, prefill, controls."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest
from memory_fixtures import FRIDAY_EVENING, choose, make_service

from agency.db import Database
from agency.memory import FakeClock, MemoryService, MemoryServiceError
from agency.memory.models import NodePatch, OnboardingAnswer, PrefillRequest, SelectionEventIn

DINNER = ["food", "delivery", "Thai Basil", "Pad thai (mild)"]


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(FRIDAY_EVENING)


@pytest.fixture
def svc(tmp_path: Path, clock: FakeClock) -> MemoryService:
    return make_service(tmp_path, clock)


def fridays(svc: MemoryService, clock: FakeClock, picks: list[list[str]]) -> None:
    """Record one pick per past Friday evening, oldest first, then return to now."""
    for i, path in enumerate(picks):
        clock.set(FRIDAY_EVENING - timedelta(weeks=len(picks) - i))
        choose(svc, path, restaurant=path[2], dish=path[3].split(" (")[0].lower(), spice="mild")
    clock.set(FRIDAY_EVENING)


def test_migration_creates_the_memory_tables(tmp_path: Path) -> None:
    db = Database(tmp_path / "m.db")
    assert db.migrate() >= 5
    names = {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"memory_nodes", "memory_events", "memory_event_nodes", "memory_notes", "memory_grants"} <= names


def test_recording_builds_the_tree_with_kinds_and_entities(svc: MemoryService) -> None:
    result = choose(svc, DINNER, restaurant="Thai Basil", spice="mild")
    assert result["stored"] and result["dropped"] == []
    by_label = {n["label"]: n for n in svc.tree()}
    assert by_label["food"]["kind"] == "area" and by_label["food"]["parentId"] is None
    assert by_label["delivery"]["kind"] == "routine"
    assert by_label["Thai Basil"]["kind"] == "entity"
    assert by_label["Thai Basil"]["attributes"] == {"type": "restaurant"}
    leaf = by_label["Pad thai (mild)"]
    assert leaf["kind"] == "choice" and leaf["attributes"]["spice"] == "mild"
    assert leaf["parentId"] == by_label["Thai Basil"]["id"]
    # The same path again reuses the same nodes, case and spacing aside.
    choose(svc, ["Food", "delivery", "thai  basil", "pad thai (mild)"])
    assert len(svc.tree()) == 4
    choose(svc, ["talk", "I'm thirsty"], surface="talk")
    assert {n["label"]: n["kind"] for n in svc.tree()}["I'm thirsty"] == "phrase"


def test_usual_friday_dinner_with_reason_and_task(svc: MemoryService, clock: FakeClock) -> None:
    other = ["food", "delivery", "Pizza Place", "Margherita (mild)"]
    fridays(svc, clock, [DINNER, other, DINNER, DINNER, DINNER])
    usual = svc.usual(["food", "delivery"])
    assert usual is not None
    assert usual["label"] == "Pad thai (mild)"
    assert usual["path"] == DINNER
    assert usual["reason"] == "You chose this 4 of your last 5 Friday evenings."
    assert usual["score"] == 0.8
    assert usual["task"]["selections"]["restaurant"] == "Thai Basil"
    assert usual["task"]["selections"]["spice"] == "mild"
    # Monday morning has no settled usual: nothing is invented.
    clock.set(FRIDAY_EVENING + timedelta(days=3) - timedelta(hours=11))
    monday = svc.usual(["food", "delivery"])
    assert monday is not None and monday["reason"] == "You chose this 4 of the last 5 times."
    assert svc.usual(["food", "nothing here"]) is None


def test_suggestions_per_surface_are_ranked_and_explained(svc: MemoryService, clock: FakeClock) -> None:
    fridays(svc, clock, [DINNER, DINNER, DINNER])
    clock.set(FRIDAY_EVENING - timedelta(days=2))
    choose(svc, ["call", "Jordan"], surface="call")
    clock.set(FRIDAY_EVENING)
    food = svc.suggestions("food")
    assert [s["label"] for s in food] == ["Pad thai (mild)"]
    # Three Fridays is a streak, not yet a usual: the reason says what happened, nothing more.
    assert food[0]["reason"] == "You chose this 3 times on Friday evenings."
    assert 0 < food[0]["score"] <= 1
    calls = svc.suggestions("call")
    assert [s["label"] for s in calls] == ["Jordan"]
    assert "task" in calls[0]
    home = svc.suggestions("home")
    assert {s["label"] for s in home} == {"Pad thai (mild)", "Jordan"}
    assert home[0]["label"] == "Pad thai (mild)"  # Friday evening


def test_keyboard_words_filter_by_prefix_and_stay_off_home(svc: MemoryService, clock: FakeClock) -> None:
    for word in ["pharmacy", "pharmacy", "phone", "please"]:
        clock.advance(minutes=5)
        choose(svc, ["keyboard", word], surface="keyboard")
    words = [s["label"] for s in svc.suggestions("keyboard", prefix="ph")]
    assert words == ["pharmacy", "phone"]
    assert "task" not in svc.suggestions("keyboard", prefix="ph")[0]
    assert svc.suggestions("home") == []


def test_talk_phrases_are_suggested_by_frequency(svc: MemoryService, clock: FakeClock) -> None:
    for i, phrase in enumerate(["Thank you", "I'm thirsty", "Thank you", "Please wait", "Thank you"]):
        clock.set(FRIDAY_EVENING - timedelta(hours=10 - i))
        choose(svc, ["talk", phrase], surface="talk")
    clock.set(FRIDAY_EVENING)
    talk = svc.suggestions("talk", limit=2)
    # Ties go to the more recent phrase.
    assert [s["label"] for s in talk] == ["Thank you", "Please wait"]


def test_pinned_comes_first_and_hidden_never_appears(svc: MemoryService, clock: FakeClock) -> None:
    fridays(svc, clock, [DINNER, DINNER, DINNER])
    choose(svc, ["food", "delivery", "Pizza Place", "Margherita"])
    pizza = next(n for n in svc.tree() if n["label"] == "Margherita")
    svc.patch(pizza["id"], NodePatch(pinned=True))
    food = svc.suggestions("food")
    assert food[0]["label"] == "Margherita" and food[0]["reason"].startswith("You pinned this.")
    thai = next(n for n in svc.tree() if n["label"] == "Thai Basil")
    svc.patch(thai["id"], NodePatch(hidden=True))
    assert [s["label"] for s in svc.suggestions("food")] == ["Margherita"]
    assert svc.usual(["food", "delivery"]) is None


def test_rename_keeps_learning_from_the_original_name(svc: MemoryService, clock: FakeClock) -> None:
    fridays(svc, clock, [DINNER, DINNER])
    leaf = next(n for n in svc.tree() if n["label"] == "Pad thai (mild)")
    renamed = svc.patch(leaf["id"], NodePatch(label="My Friday pad thai"))
    assert renamed["label"] == "My Friday pad thai"
    choose(svc, DINNER)  # surfaces still send the original name
    assert sum(1 for n in svc.tree() if n["kind"] == "choice") == 1
    assert svc.suggestions("food")[0]["label"] == "My Friday pad thai"
    assert svc.node_detail(leaf["id"])["timesChosen"] == 3


def test_forget_removes_the_subtree_and_its_events(svc: MemoryService, clock: FakeClock) -> None:
    fridays(svc, clock, [DINNER, DINNER, DINNER])
    choose(svc, ["food", "delivery", "Pizza Place", "Margherita"])
    thai = next(n for n in svc.tree() if n["label"] == "Thai Basil")
    assert svc.forget(thai["id"]) == {"forgotten": 2}
    labels = {n["label"] for n in svc.tree()}
    assert "Thai Basil" not in labels and "Pad thai (mild)" not in labels and "Margherita" in labels
    assert svc.store.counts()["events"] == 1
    assert svc.usual(["food", "delivery"]) is None
    with pytest.raises(MemoryServiceError):
        svc.forget(thai["id"])


def test_forgetting_the_last_leaf_prunes_empty_parents(svc: MemoryService) -> None:
    choose(svc, DINNER)
    leaf = next(n for n in svc.tree() if n["label"] == "Pad thai (mild)")
    svc.forget(leaf["id"])
    assert svc.tree() == []


def test_forget_everything_needs_confirmation(svc: MemoryService) -> None:
    choose(svc, DINNER)
    with pytest.raises(MemoryServiceError):
        svc.forget_all(False)
    assert svc.forget_all(True)["forgotten"]["events"] == 1
    assert svc.tree() == [] and svc.store.counts() == {"nodes": 0, "events": 0, "notes": 0}


def test_cold_start_from_onboarding(svc: MemoryService) -> None:
    svc.onboard(
        [
            OnboardingAnswer(path=DINNER, surface="food", weekday=4, daypart="evening", attributes={"restaurant": "Thai Basil"}),
            OnboardingAnswer(path=["call", "Jordan"], surface="call"),
        ]
    )
    food = svc.suggestions("food")
    assert food[0]["label"] == "Pad thai (mild)"
    assert food[0]["reason"] == "You told AGENCY about this during setup."
    assert svc.usual(["food", "delivery"]) is None  # setup answers are not history
    detail = svc.node_detail(food[0]["nodeId"])
    assert detail["fromSetup"] and detail["timesChosen"] == 0


def test_prefill_only_when_settled(svc: MemoryService, clock: FakeClock) -> None:
    question = {
        "id": "q-spice",
        "prompt": "How spicy?",
        "options": [{"id": "mild", "label": "Mild"}, {"id": "medium", "label": "Medium"}, {"id": "hot", "label": "Hot"}],
    }
    req = PrefillRequest.model_validate({"path": ["food", "delivery"], "question": question})
    assert svc.prefill(req) is None
    fridays(svc, clock, [DINNER, DINNER, DINNER])
    assert svc.prefill(req) is None  # three times is a streak, not yet settled
    clock.set(FRIDAY_EVENING - timedelta(weeks=4))
    choose(svc, DINNER, spice="mild")
    clock.set(FRIDAY_EVENING)
    result = svc.prefill(req)
    assert result == {
        "questionId": "q-spice",
        "optionId": "mild",
        "score": 1.0,
        "reason": "You chose Mild 4 of your last 4 Friday evenings.",
    }
    # Options can match a level of the path too (which restaurant?).
    where = PrefillRequest.model_validate(
        {
            "path": ["food", "delivery"],
            "question": {
                "id": "q2",
                "prompt": "Where from?",
                "options": [{"id": "tb", "label": "Thai Basil"}, {"id": "pp", "label": "Pizza Place"}],
            },
        }
    )
    assert svc.prefill(where)["optionId"] == "tb"  # type: ignore[index]


def test_learning_paused_stores_nothing(svc: MemoryService) -> None:
    settings = svc.settings().model_copy(update={"learning_paused": True})
    svc.save_settings(settings)
    assert choose(svc, DINNER)["stored"] is False
    assert svc.tree() == []


def test_half_life_is_configurable(svc: MemoryService, clock: FakeClock) -> None:
    for weeks in (15, 14, 13):  # three Friday evenings, three months ago
        clock.set(FRIDAY_EVENING - timedelta(weeks=weeks))
        choose(svc, ["food", "delivery", "Old place", "Old dish"])
    clock.set(FRIDAY_EVENING - timedelta(weeks=1))
    choose(svc, ["food", "delivery", "New place", "New dish"])
    clock.set(FRIDAY_EVENING)
    svc.save_settings(svc.settings().model_copy(update={"half_life_days": 365}))
    assert svc.suggestions("food")[0]["label"] == "Old dish"
    svc.save_settings(svc.settings().model_copy(update={"half_life_days": 7}))
    assert svc.suggestions("food")[0]["label"] == "New dish"


def test_events_use_the_person_s_time_zone(svc: MemoryService, clock: FakeClock) -> None:
    # 23:30 UTC on Friday is 7:30 pm Friday in New York.
    svc.record(SelectionEventIn(path=DINNER, surface="food", outcome="chosen", at="2026-10-02T23:30:00Z"))
    row = svc.db.query_one("SELECT weekday, hour FROM memory_events")
    assert row is not None and (row["weekday"], row["hour"]) == (4, 19)
    with pytest.raises(MemoryServiceError):
        svc.record(SelectionEventIn(path=DINNER, surface="food", outcome="chosen", at="2027-01-01T00:00:00Z"))


def test_home_usuals_are_settled_per_area(svc: MemoryService, clock: FakeClock) -> None:
    fridays(svc, clock, [DINNER, DINNER, DINNER, DINNER])
    # Calls made just now, in the same slot, must not dilute the dinner habit.
    choose(svc, ["call", "Pharmacy"], surface="call")
    clock.advance(minutes=10)
    choose(svc, ["call", "Jordan"], surface="call")
    home = {s["label"]: s for s in svc.suggestions("home")}
    assert home["Pad thai (mild)"]["reason"] == "You chose this 4 of your last 4 Friday evenings."
