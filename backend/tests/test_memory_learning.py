"""Pure learning functions: decay, context, sequences, usuals, rejections and reasons."""

from __future__ import annotations

from datetime import datetime, timedelta

from memory_fixtures import FRIDAY_EVENING, TZ

from agency.memory.learning import (
    Context,
    EventRecord,
    Facts,
    Params,
    UsualFact,
    daypart,
    decay,
    describe,
    occasions,
    rank,
    similarity,
    usual_of,
)


def ev(node: str, at: datetime, outcome: str = "chosen", surface: str = "food", source: str = "event") -> EventRecord:
    return EventRecord(node, ("area", node), surface, outcome, source, at, at.weekday(), at.hour)


def test_dayparts_cover_the_clock() -> None:
    assert [daypart(h) for h in (4, 5, 10, 11, 13, 14, 16, 17, 21, 22, 23)] == [
        "night",
        "morning",
        "morning",
        "midday",
        "midday",
        "afternoon",
        "afternoon",
        "evening",
        "evening",
        "night",
        "night",
    ]


def test_decay_halves_every_half_life() -> None:
    assert decay(timedelta(0), 30) == 1.0
    assert abs(decay(timedelta(days=30), 30) - 0.5) < 1e-9
    assert abs(decay(timedelta(days=60), 30) - 0.25) < 1e-9


def test_similarity_prefers_the_same_slot() -> None:
    fri_eve = Context(4, "evening")
    assert similarity(fri_eve, fri_eve) == 1.0
    assert similarity(Context(3, "evening"), fri_eve) > similarity(Context(5, "evening"), fri_eve)
    assert similarity(Context(5, "evening"), fri_eve) > similarity(Context(4, "morning"), fri_eve) * 0.5
    assert similarity(Context(0, "morning"), fri_eve) < 0.2


def test_repeats_within_half_an_hour_are_one_occasion() -> None:
    t = FRIDAY_EVENING
    occs = occasions(
        [
            ev("a", t),
            ev("a", t + timedelta(minutes=1)),  # double log
            ev("a", t + timedelta(minutes=5), "completed"),  # the same dinner going through
            ev("a", t + timedelta(minutes=10)),  # chosen again: a second time
            ev("a", t + timedelta(hours=2)),
        ]
    )
    assert len(occs) == 3
    assert occasions([ev("a", t, "abandoned")]) == []


def test_context_conditioning_friday_evening_differs_from_monday_morning() -> None:
    occs = []
    for week in range(1, 7):
        occs.append(ev("thai", FRIDAY_EVENING - timedelta(weeks=week)))
        monday_morning = FRIDAY_EVENING - timedelta(weeks=week, days=4, hours=11)
        occs.append(ev("bagel", monday_morning))
        occs.append(ev("bagel", monday_morning + timedelta(days=1)))
    params = Params()
    o = occasions(occs)
    friday = rank(o, {"thai", "bagel"}, FRIDAY_EVENING, params)
    assert friday[0].node_id == "thai"
    monday = FRIDAY_EVENING + timedelta(days=3) - timedelta(hours=11)  # Monday 8 am
    assert monday.weekday() == 0 and monday.hour == 8
    ranked = rank(o, {"thai", "bagel"}, monday, params)
    assert ranked[0].node_id == "bagel"


def test_recency_lets_a_new_habit_overtake_an_old_one() -> None:
    occs = [ev("old", FRIDAY_EVENING - timedelta(days=d)) for d in range(60, 200, 7)]
    occs += [ev("new", FRIDAY_EVENING - timedelta(days=d)) for d in (7, 14, 21)]
    ranked = rank(occasions(occs), {"old", "new"}, FRIDAY_EVENING, Params(half_life_days=14))
    assert ranked[0].node_id == "new"


def test_sequences_after_the_pharmacy_call_they_message_jordan() -> None:
    occs = []
    for week in range(1, 5):
        call = FRIDAY_EVENING - timedelta(weeks=week, hours=5)
        occs.append(ev("pharmacy", call, surface="call"))
        occs.append(ev("jordan", call + timedelta(minutes=40), surface="call"))
        occs.append(ev("mum", call - timedelta(days=2), surface="call"))
        occs.append(ev("mum", call - timedelta(days=3), surface="call"))
    now = FRIDAY_EVENING - timedelta(hours=4)
    occs.append(ev("pharmacy", now - timedelta(minutes=20), surface="call"))
    o = occasions(occs)
    ranked = rank(o, {"jordan", "mum"}, now, Params())
    assert ranked[0].node_id == "jordan"
    assert ranked[0].facts.after_node == "pharmacy"
    assert ranked[0].facts.after_count == 4
    assert describe(ranked[0].facts, now, {"pharmacy": "the pharmacy"}) == "After the pharmacy, you chose this 4 of 4 times."


def test_usual_needs_three_of_the_last_four_or_five() -> None:
    def items(keys: list[str]) -> list[tuple[object, str]]:
        return [
            (o, o.node_id)
            for o in occasions([ev(k, FRIDAY_EVENING - timedelta(weeks=len(keys) - i)) for i, k in enumerate(keys)])
        ]

    now = Context(4, "evening")
    found = usual_of(items(["a", "b", "a", "a", "a"]), now, Params())  # type: ignore[arg-type]
    assert found is not None and found[0] == "a" and found[1].count == 4 and found[1].window == 5
    assert found[1].phrase() == "4 of your last 5 Friday evenings"
    assert usual_of(items(["a", "b", "a", "b"]), now, Params()) is None  # type: ignore[arg-type]
    assert usual_of(items(["a", "a"]), now, Params()) is None  # type: ignore[arg-type]
    # Only the last five count: an old habit doesn't keep its "usual" forever.
    assert usual_of(items(["a"] * 6 + ["b"] * 4), now, Params())[0] == "b"  # type: ignore[arg-type,index]


def test_usual_falls_back_to_coarser_context_only_when_the_slot_has_little_history() -> None:
    occs = occasions([ev("a", FRIDAY_EVENING - timedelta(days=d, hours=1)) for d in (1, 2, 3, 4)])
    found = usual_of([(o, o.node_id) for o in occs], Context(4, "evening"), Params())
    assert found is not None and found[1].tier == "daypart"
    assert found[1].phrase() == "4 of your last 4 evenings"


def test_onboarding_answers_seed_suggestions_but_never_count_as_history() -> None:
    occs = occasions([ev("thai", FRIDAY_EVENING - timedelta(days=1), source="onboarding")])
    ranked = rank(occs, {"thai"}, FRIDAY_EVENING, Params())
    assert ranked and ranked[0].facts.onboarding and ranked[0].facts.count == 0
    assert describe(ranked[0].facts, FRIDAY_EVENING, {}) == "You told AGENCY about this during setup."
    assert usual_of([(o, o.node_id) for o in occs * 3], Context(4, "evening"), Params()) is None


def test_rejections_demote_a_suggestion_quickly() -> None:
    base = [ev("a", FRIDAY_EVENING - timedelta(weeks=w)) for w in (1, 2, 3)]
    base += [ev("b", FRIDAY_EVENING - timedelta(weeks=w)) for w in (1, 2)]
    assert rank(occasions(base), {"a", "b"}, FRIDAY_EVENING, Params())[0].node_id == "a"
    rejected = base + [ev("a", FRIDAY_EVENING - timedelta(hours=1), "rejected")]
    ranked = rank(occasions(rejected), {"a", "b"}, FRIDAY_EVENING, Params())
    assert ranked[0].node_id == "b"
    assert next(r for r in ranked if r.node_id == "a").facts.rejected_recently == 1


def test_never_chosen_candidates_are_not_suggested() -> None:
    occs = occasions([ev("x", FRIDAY_EVENING - timedelta(days=1), "rejected")])
    assert rank(occs, {"x", "y"}, FRIDAY_EVENING, Params()) == []


def test_reasons_are_built_only_from_counts() -> None:
    now = FRIDAY_EVENING
    assert describe(Facts(usual=UsualFact(4, 5, "weekday", Context(4, "evening"))), now, {}) == (
        "You chose this 4 of your last 5 Fridays."
    )
    assert describe(Facts(count=3, slot_count=3), now, {}) == "You chose this 3 times on Friday evenings."
    assert describe(Facts(count=7, count_30d=7), now, {}) == "You chose this 7 times in the last 30 days."
    assert describe(Facts(count=1, count_30d=1, last_at=now - timedelta(days=1)), now, {}) == "You chose this yesterday."
    assert describe(Facts(count=1, last_at=datetime(2026, 3, 3, 12, tzinfo=TZ)), now, {}) == "You chose this on 3 March."
    assert describe(Facts(count=1, last_at=now - timedelta(days=1)), now, {}, pinned=True).startswith("You pinned this. ")
