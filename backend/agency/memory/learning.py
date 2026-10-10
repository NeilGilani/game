"""Explainable learning over recorded selections.

Everything here is a pure function of the recorded events and "now", so it is easy to test with a
fake clock and to benchmark. The model is deliberately simple and countable:

* **Occasions.** Choosing something and then completing it within 30 minutes is one occasion (one
  dinner, not two); repeats within two minutes are double logs.
* **Recency.** Each occasion weighs ``0.5 ** (age / half_life)``.
* **Context.** The share of each option on this weekday at this time of day, backing off to the same
  time of day on weekdays (or weekends), then that time of day, then any time, when the narrow
  context has little history.
* **Sequences.** What the person picked next, within a few hours, after the thing they just did
  (small talk and keyboard words don't start a sequence).
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


LEVELS = ("slot", "kind", "daypart", "all")


def same_level(a: Context, b: Context, level: str) -> bool:
    """slot: same weekday and time of day; kind: same time of day on a weekday (or weekend) day."""
    if level == "slot":
        return a == b
    if level == "kind":
        return a.daypart == b.daypart and a.weekend == b.weekend
    if level == "daypart":
        return a.daypart == b.daypart
    return True


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
    # Pseudo-count for backing off from a narrow context (Friday evening) to a wider one (weekday
    # evenings, then evenings, then any time). Higher trusts narrow contexts less.
    backoff: float = 2.0
    w_sequence: float = 0.5
    # Rejected-suggestion weight multiplies the penalty: score / (1 + rejection_penalty * rejections).
    rejection_penalty: float = 2.0
    # Surfaces whose selections don't start a sequence (single words, small talk).
    sequence_skip: frozenset[str] = frozenset({"talk", "keyboard"})
    # A usual also needs this share of the (recency-weighted) history in its context.
    usual_share: float = 0.6
    sequence_window: timedelta = timedelta(hours=3)
    onboarding_weight: float = 1.0
    usual_window: int = 5
    usual_min: int = 3
    # "3 of the last 3" is a streak, not a habit: the context needs at least this many occasions.
    usual_history: int = 4
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


def usual_of(
    items: Sequence[tuple[Occasion, str]], now: Context, params: Params, at: datetime | None = None
) -> tuple[str, UsualFact] | None:
    """The usual key among (occasion, key) pairs, oldest first, or None if nothing is settled.

    The closest context with enough history decides; if that context is mixed, there is no usual
    (a mixed Friday is not rescued by a settled Monday). The usual must also hold at least
    ``usual_share`` of that context's recency-weighted history, so a lucky streak in an otherwise
    varied context isn't presented as a habit. ``at`` (the current time) enables that weighting.
    """
    real = [(o, k) for o, k in items if o.kind == "positive" and not o.onboarding]
    tiers: list[tuple[Literal["slot", "weekday", "daypart", "all"], list[tuple[Occasion, str]]]] = [
        ("slot", [(o, k) for o, k in real if o.context.weekday == now.weekday and o.context.daypart == now.daypart]),
        ("weekday", [(o, k) for o, k in real if o.context.weekday == now.weekday]),
        ("daypart", [(o, k) for o, k in real if o.context.daypart == now.daypart]),
        ("all", real),
    ]
    for tier, pool in tiers:
        if len(pool) < max(params.usual_min, params.usual_history):
            continue
        window = pool[-params.usual_window :]
        counts: dict[str, int] = defaultdict(int)
        for _, key in window:
            counts[key] += 1
        # Ties go to the most recent choice.
        best = max(counts, key=lambda k: (counts[k], max(i for i, (_, kk) in enumerate(window) if kk == k)))
        if counts[best] < params.usual_min or counts[best] / len(window) < 0.6:
            return None
        if at is not None:
            weights = [(decay(at - o.at, params.half_life_days), k) for o, k in pool]
            total = sum(w for w, _ in weights)
            if total > 0 and sum(w for w, k in weights if k == best) / total < params.usual_share:
                return None
        return best, UsualFact(counts[best], len(window), tier, now)
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


def last_positive_before(
    occs: Sequence[Occasion], now: datetime, window: timedelta, skip: frozenset[str] = frozenset()
) -> Occasion | None:
    for occ in reversed(occs):
        if occ.at > now:
            continue
        if now - occ.at > window:
            return None
        if occ.kind == "positive" and not occ.onboarding and occ.surface not in skip:
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

    The context model backs off: the share of each candidate among recency-weighted occasions in
    the same slot (Friday evening), smoothed toward the same time of day on the same kind of day,
    then the same time of day, then any time, then uniform. A narrow context with plenty of
    history speaks for itself; one with little history mostly borrows from the wider ones.
    """
    ctx = context or Context.of(now)
    cand = set(candidates)
    if not cand:
        return []
    horizon = now - params.horizon
    mass: dict[str, dict[str, float]] = {level: defaultdict(float) for level in LEVELS}
    total: dict[str, float] = dict.fromkeys(LEVELS, 0.0)
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
        for level in LEVELS:
            if same_level(occ.context, ctx, level):
                mass[level][occ.node_id] += w
                total[level] += w

    k = params.backoff
    p_ctx = {n: 1.0 / len(cand) for n in cand}
    for level in reversed(LEVELS):
        p_ctx = {n: (mass[level].get(n, 0.0) + k * p_ctx[n]) / (total[level] + k) for n in cand}

    # Sequences: after the most recent selection, what did they pick next among the candidates?
    every = [
        o
        for o in (sequence_occasions if sequence_occasions is not None else occs)
        if o.kind == "positive" and not o.onboarding and horizon <= o.at <= now
    ]
    seq: dict[str, float] = defaultdict(float)
    seq_counts: dict[str, int] = defaultdict(int)
    seq_total = 0
    prev = last_positive_before(every, now, params.sequence_window, params.sequence_skip)
    if prev is not None:
        for i, a in enumerate(every):
            if a.node_id != prev.node_id or a.at >= prev.at:
                continue
            seq_total += 1
            for b in every[i + 1 :]:
                if b.at - a.at > params.sequence_window:
                    break
                if b.node_id in cand and b.node_id != a.node_id:
                    seq_counts[b.node_id] += 1
                    seq[b.node_id] += decay(now - b.at, params.half_life_days)
                    break
    followed = sum(seq_counts.values())
    seq_mass = sum(seq.values())
    w_seq = params.w_sequence * (followed / seq_total) if seq_total >= 2 and followed >= 2 and seq_mass > 0 else 0.0

    # A usual is settled within an area: Friday dinner is one question, Friday calls another.
    by_area: dict[str, list[tuple[Occasion, str]]] = defaultdict(list)
    for o in occs:
        if o.node_id in cand and horizon <= o.at <= now:
            by_area[o.path_ids[0] if o.path_ids else ""].append((o, o.node_id))
    usuals: dict[str, UsualFact] = {}
    for items in by_area.values():
        found = usual_of(items, ctx, params, now)
        if found is not None:
            usuals[found[0]] = found[1]

    ranked: list[Ranked] = []
    for n in cand:
        score = (1.0 - w_seq) * p_ctx[n] + (w_seq * seq.get(n, 0.0) / seq_mass if w_seq else 0.0)
        score /= 1.0 + params.rejection_penalty * rejw[n]
        f = facts[n]
        f.usual = usuals.get(n)
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
