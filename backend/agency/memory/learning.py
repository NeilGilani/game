"""Explainable learning over recorded selections.

Everything here is a pure function of the recorded events and "now", so it is easy to test with a
fake clock and to benchmark. The model is deliberately simple and countable:

* **Occasions.** Choosing something and then completing it within 30 minutes is one occasion (one
  dinner, not two); repeats within two minutes are double logs.
* **Recency.** Each occasion weighs ``0.5 ** (age / half_life)``.
* **Context.** Occasions in a similar context weigh more: same weekday and time of day most, then
  same time of day on the same kind of day (weekday or weekend), and so on.
* **Sequences.** What the person picked after the thing they just did, within a few hours.
* **Usuals.** In the closest context with at least ``usual_min`` occasions, the same choice at least
  ``usual_min`` times in the last ``usual_window`` (and at least 60% of them).
* **Rejections** of a suggestion make it less likely, so a wrong guess fades quickly.

Each ranked result carries the counts it was built from, and :func:`describe` turns those counts
into a plain sentence. A reason is only ever built from counts, never from the score.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
DAYPARTS = ("morning", "midday", "afternoon", "evening", "night")
DAYPART_HOUR = {"morning": 8, "midday": 12, "afternoon": 15, "evening": 19, "night": 23}
DAYPART_PLURAL = {
    "morning": "mornings",
    "midday": "lunchtimes",
    "afternoon": "afternoons",
    "evening": "evenings",
    "night": "nights",
}


def daypart(hour: int) -> str:
    if 5 <= hour < 11:
        return "morning"
    if 11 <= hour < 14:
        return "midday"
    if 14 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 22:
        return "evening"
    return "night"


@dataclass(frozen=True)
class Context:
    weekday: int
    daypart: str

    @property
    def weekend(self) -> bool:
        return self.weekday >= 5

    @staticmethod
    def of(when: datetime) -> Context:
        return Context(when.weekday(), daypart(when.hour))


def similarity(a: Context, b: Context) -> float:
    """How much an occasion in context ``a`` says about context ``b`` (1 = same slot)."""
    same_day = a.weekday == b.weekday
    same_part = a.daypart == b.daypart
    same_kind = a.weekend == b.weekend
    if same_day and same_part:
        return 1.0
    if same_part and same_kind:
        return 0.5
    if same_part:
        return 0.3
    if same_day:
        return 0.25
    if same_kind:
        return 0.1
    return 0.05


@dataclass(frozen=True)
class EventRecord:
    node_id: str
    path_ids: tuple[str, ...]
    surface: str
    outcome: str
    source: str  # "event" or "onboarding"
    at: datetime
    weekday: int
    hour: int


@dataclass(frozen=True)
class Occasion:
    node_id: str
    path_ids: tuple[str, ...]
    surface: str
    at: datetime
    context: Context
    kind: Literal["positive", "rejected"]
    onboarding: bool


@dataclass(frozen=True)
class Params:
    half_life_days: float = 30.0
    w_context: float = 0.5
    w_frequency: float = 0.25
    w_sequence: float = 0.35
    sequence_window: timedelta = timedelta(hours=3)
    onboarding_weight: float = 1.0
    usual_window: int = 5
    usual_min: int = 3
    # Occasions older than this many half-lives weigh under 0.4% and are ignored.
    horizon_half_lives: float = 8.0

    @property
    def horizon(self) -> timedelta:
        return timedelta(days=self.half_life_days * self.horizon_half_lives)


def occasions(
    events: Iterable[EventRecord],
    collapse: timedelta = timedelta(minutes=30),
    duplicate: timedelta = timedelta(minutes=2),
) -> list[Occasion]:
    """Collapse raw events into occasions (oldest first). Abandoned selections teach nothing.

    "Completed" within ``collapse`` of choosing the same thing is the same occasion (choosing a
    dish, then the order going through). Any repeat within ``duplicate`` is a double log. Saying
    the same phrase twice, minutes apart, still counts twice.
    """
    result: list[Occasion] = []
    last: dict[tuple[str, str], EventRecord] = {}
    for ev in sorted(events, key=lambda e: e.at):
        if ev.outcome == "abandoned":
            continue
        kind: Literal["positive", "rejected"] = "rejected" if ev.outcome == "rejected" else "positive"
        key = (ev.node_id, kind)
        previous = last.get(key)
        if previous is not None and ev.source != "onboarding" and previous.source != "onboarding":
            gap = ev.at - previous.at
            if gap <= duplicate or (ev.outcome == "completed" and previous.outcome == "chosen" and gap <= collapse):
                continue
        last[key] = ev
        result.append(
            Occasion(
                node_id=ev.node_id,
                path_ids=ev.path_ids,
                surface=ev.surface,
                at=ev.at,
                context=Context(ev.weekday, daypart(ev.hour)),
                kind=kind,
                onboarding=ev.source == "onboarding",
            )
        )
    return result


def decay(age: timedelta, half_life_days: float) -> float:
    days = max(0.0, age.total_seconds() / 86400.0)
    return float(0.5 ** (days / half_life_days))


@dataclass(frozen=True)
class UsualFact:
    count: int
    window: int
    tier: Literal["slot", "weekday", "daypart", "all"]
    context: Context

    def phrase(self) -> str:
        day = WEEKDAYS[self.context.weekday]
        if self.tier == "slot":
            return f"{self.count} of your last {self.window} {day} {DAYPART_PLURAL[self.context.daypart]}"
        if self.tier == "weekday":
            return f"{self.count} of your last {self.window} {day}s"
        if self.tier == "daypart":
            return f"{self.count} of your last {self.window} {DAYPART_PLURAL[self.context.daypart]}"
        return f"{self.count} of the last {self.window} times"


def usual_of(items: Sequence[tuple[Occasion, str]], now: Context, params: Params) -> tuple[str, UsualFact] | None:
    """The usual key among (occasion, key) pairs, oldest first, or None if nothing is settled.

    The closest context with enough history decides; if that context is mixed, there is no usual
    (a mixed Friday is not rescued by a settled Monday).
    """
    real = [(o, k) for o, k in items if o.kind == "positive" and not o.onboarding]
    tiers: list[tuple[Literal["slot", "weekday", "daypart", "all"], list[tuple[Occasion, str]]]] = [
        ("slot", [(o, k) for o, k in real if o.context.weekday == now.weekday and o.context.daypart == now.daypart]),
        ("weekday", [(o, k) for o, k in real if o.context.weekday == now.weekday]),
        ("daypart", [(o, k) for o, k in real if o.context.daypart == now.daypart]),
        ("all", real),
    ]
    for tier, pool in tiers:
        if len(pool) < params.usual_min:
            continue
        window = pool[-params.usual_window :]
        counts: dict[str, int] = defaultdict(int)
        for _, key in window:
            counts[key] += 1
        # Ties go to the most recent choice.
        best = max(counts, key=lambda k: (counts[k], max(i for i, (_, kk) in enumerate(window) if kk == k)))
        if counts[best] >= params.usual_min and counts[best] / len(window) >= 0.6:
            return best, UsualFact(counts[best], len(window), tier, now)
        return None
    return None


@dataclass
class Facts:
    """Counts behind one ranked candidate. Reasons are built only from these."""

    count: int = 0
    count_30d: int = 0
    slot_count: int = 0
    last_at: datetime | None = None
    onboarding: bool = False
    usual: UsualFact | None = None
    after_node: str | None = None
    after_count: int = 0
    after_total: int = 0
    rejected_recently: int = 0


@dataclass
class Ranked:
    node_id: str
    score: float
    facts: Facts = field(default_factory=Facts)


def last_positive_before(occs: Sequence[Occasion], now: datetime, window: timedelta) -> Occasion | None:
    for occ in reversed(occs):
        if occ.at > now:
            continue
        if now - occ.at > window:
            return None
        if occ.kind == "positive" and not occ.onboarding:
            return occ
    return None


def rank(
    occs: Sequence[Occasion],
    candidates: Iterable[str],
    now: datetime,
    params: Params,
    *,
    context: Context | None = None,
    sequence_occasions: Sequence[Occasion] | None = None,
) -> list[Ranked]:
    """Rank ``candidates`` (node ids) for ``now``.

    ``occs`` are the occasions that bear on the candidates (oldest first). ``sequence_occasions``
    are all occasions across surfaces, used to learn "after X they usually pick Y"; it defaults to
    ``occs``.
    """
    ctx = context or Context.of(now)
    cand = set(candidates)
    if not cand:
        return []
    horizon = now - params.horizon
    freq: dict[str, float] = defaultdict(float)
    ctxw: dict[str, float] = defaultdict(float)
    rejw: dict[str, float] = defaultdict(float)
    facts: dict[str, Facts] = {n: Facts() for n in cand}
    month_ago = now - timedelta(days=30)
    fortnight = now - timedelta(days=14)
    for occ in occs:
        if occ.node_id not in cand or occ.at > now or occ.at < horizon:
            continue
        w = decay(now - occ.at, params.half_life_days)
        f = facts[occ.node_id]
        if occ.kind == "rejected":
            rejw[occ.node_id] += w * similarity(occ.context, ctx)
            if occ.at >= fortnight:
                f.rejected_recently += 1
            continue
        if occ.onboarding:
            w *= params.onboarding_weight
            f.onboarding = True
        else:
            f.count += 1
            if occ.at >= month_ago:
                f.count_30d += 1
            if occ.context == ctx:
                f.slot_count += 1
            if f.last_at is None or occ.at > f.last_at:
                f.last_at = occ.at
        freq[occ.node_id] += w
        ctxw[occ.node_id] += w * similarity(occ.context, ctx)

    # Sequences: what followed the most recent selection, within the window.
    seq: dict[str, float] = defaultdict(float)
    seq_counts: dict[str, int] = defaultdict(int)
    seq_total = 0
    every = list(sequence_occasions if sequence_occasions is not None else occs)
    prev = last_positive_before(every, now, params.sequence_window)
    if prev is not None:
        positives = [o for o in every if o.kind == "positive" and not o.onboarding and horizon <= o.at <= now]
        for a, b in zip(positives, positives[1:], strict=False):
            if a.node_id != prev.node_id or b.node_id == a.node_id or b.at - a.at > params.sequence_window:
                continue
            seq_total += 1
            seq_counts[b.node_id] += 1
            if b.node_id in cand:
                seq[b.node_id] += decay(now - b.at, params.half_life_days)

    def normalized(values: Mapping[str, float]) -> dict[str, float]:
        total = sum(values.get(n, 0.0) for n in cand)
        return {n: values.get(n, 0.0) / total for n in cand} if total > 0 else {}

    parts = [(params.w_context, normalized(ctxw)), (params.w_frequency, normalized(freq))]
    if seq_total >= 2:
        parts.append((params.w_sequence, normalized(seq)))
    weight = sum(w for w, dist in parts if dist)
    usual_items = [(o, o.node_id) for o in occs if o.node_id in cand and horizon <= o.at <= now]
    usual = usual_of(usual_items, ctx, params)

    ranked: list[Ranked] = []
    for n in cand:
        score = sum(w * dist.get(n, 0.0) for w, dist in parts if dist) / weight if weight else 0.0
        score /= 1.0 + 2.0 * rejw[n]
        f = facts[n]
        if usual is not None and usual[0] == n:
            f.usual = usual[1]
        if prev is not None and seq_counts.get(n):
            f.after_node = prev.node_id
            f.after_count = seq_counts[n]
            f.after_total = seq_total
        if f.count == 0 and not f.onboarding:
            continue  # never chosen (or only rejected): nothing to suggest
        ranked.append(Ranked(n, round(min(1.0, max(0.0, score)), 4), f))
    ranked.sort(key=lambda r: (-r.score, -(r.facts.last_at.timestamp() if r.facts.last_at else 0.0), r.node_id))
    return ranked


def _when(last: datetime, now: datetime) -> str:
    days = (now.date() - last.date()).days
    if days <= 0:
        return "earlier today"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"on {WEEKDAYS[last.weekday()]}"
    return f"on {last.day} {last.strftime('%B')}"


def times(n: int) -> str:
    return "once" if n == 1 else "twice" if n == 2 else f"{n} times"


def describe(facts: Facts, now: datetime, labels: Mapping[str, str], *, pinned: bool = False) -> str:
    """One plain sentence, built only from recorded counts."""
    ctx = Context.of(now)
    lead = "You pinned this. " if pinned else ""
    if facts.after_node and facts.after_count >= 2 and facts.after_count * 2 >= facts.after_total:
        prev = labels.get(facts.after_node, "that")
        return f"{lead}After {prev}, you chose this {facts.after_count} of {facts.after_total} times."
    if facts.usual is not None:
        return f"{lead}You chose this {facts.usual.phrase()}."
    if facts.slot_count >= 2:
        slot = f"{WEEKDAYS[ctx.weekday]} {DAYPART_PLURAL[ctx.daypart]}"
        return f"{lead}You chose this {times(facts.slot_count)} on {slot}."
    if facts.count_30d >= 2:
        return f"{lead}You chose this {times(facts.count_30d)} in the last 30 days."
    if facts.last_at is not None:
        return f"{lead}You chose this {_when(facts.last_at, now)}."
    if facts.onboarding:
        return f"{lead}You told AGENCY about this during setup."
    return lead.strip() or "You chose this before."
