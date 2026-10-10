"""Offline evaluation of memory suggestions on synthetic personas.

    cd backend && .venv/bin/python -m agency.memory.bench            # held-out seeds, writes nothing
    cd backend && .venv/bin/python -m agency.memory.bench --markdown # tables for BENCHMARKS.md

Personas are generated, not real people: routines with context (weekday, time of day), sequences
(pharmacy call, then a message), a long tail of phrases, and noise. Every selection is replayed in
time order; before each one, each predictor ranks the options using only what happened earlier,
and we check whether the actual choice was its first (top-1) or among its first three (top-3).

Predictors:
* ``memory``: this module's learner (context, recency, sequences, rejections not used here).
* ``frequent``: the options chosen most often on that surface so far.
* ``recent``: the options chosen most recently on that surface.
"""

from __future__ import annotations

import argparse
import random
import statistics
import time
from collections import Counter, defaultdict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from .learning import Context, EventRecord, Params, occasions, rank, usual_of

START = datetime(2026, 1, 5, tzinfo=UTC)  # a Monday; times are treated as the person's local time
DAYS = 140
WARMUP_DAYS = 14
CHANGE_DAY = 84  # the "habit change" persona switches its Friday dinner here (a Monday, week 12)


@dataclass(frozen=True)
class Pick:
    at: datetime
    surface: str
    leaf: str


Generator = Callable[[random.Random], Iterator[Pick]]


def _noise(rng: random.Random, p: float, usual: str, pool: list[str]) -> str:
    return rng.choice(pool) if rng.random() < p else usual


def _at(day: int, hour: int, rng: random.Random) -> datetime:
    return START + timedelta(days=day, hours=hour, minutes=rng.randint(0, 50))


DINNERS = ["Thai Basil: pad thai", "Pizza Place: margherita", "Sushi Go: salmon set", "Taco Spot: 3 tacos", "Home cooking"]
LUNCHES = ["Soup", "Sandwich", "Salad", "Leftovers"]
PHRASES = [f"Phrase {i}" for i in range(30)]
CONTACTS = ["Mum", "Jordan", "Sam", "Dr Lee", "Aunt Rosa"]


def riley(rng: random.Random, *, noise: float = 0.2, change: bool = False) -> Iterator[Pick]:
    """Routine-heavy: Friday Thai, weekday soup, Sunday call to Mum, pharmacy then Jordan."""
    for day in range(DAYS):
        weekday = (START + timedelta(days=day)).weekday()
        friday_usual = "Sushi Go: salmon set" if change and day >= CHANGE_DAY else "Thai Basil: pad thai"
        if weekday == 4:
            yield Pick(_at(day, 19, rng), "food", _noise(rng, noise, friday_usual, DINNERS))
        elif weekday >= 5:
            yield Pick(_at(day, 18, rng), "food", _noise(rng, noise, "Pizza Place: margherita", DINNERS))
        else:
            yield Pick(_at(day, 18, rng), "food", _noise(rng, noise * 2, "Home cooking", DINNERS))
            yield Pick(_at(day, 12, rng), "food", _noise(rng, noise, "Soup" if weekday < 3 else "Sandwich", LUNCHES))
        if weekday == 6:
            yield Pick(_at(day, 10, rng), "call", _noise(rng, noise, "Mum", CONTACTS))
        if day % 14 == 3:
            t = _at(day, 14, rng)
            yield Pick(t, "call", "Pharmacy")
            yield Pick(t + timedelta(minutes=35), "call", _noise(rng, noise, "Jordan", CONTACTS))
        for _ in range(rng.randint(2, 5)):
            yield from _talk(rng, day)
        if weekday == 5:
            yield Pick(
                _at(day, 11, rng), "shopping", _noise(rng, noise, "Groceries: usual basket", ["Pharmacy order", "Pet food"])
            )


def _talk(rng: random.Random, day: int) -> Iterator[Pick]:
    hour = rng.choice([8, 9, 12, 15, 19, 21])
    if hour <= 9 and rng.random() < 0.6:
        phrase = "Good morning"
    elif hour >= 21 and rng.random() < 0.6:
        phrase = "Good night"
    else:
        # Zipf-like long tail.
        idx = min(int(rng.paretovariate(1.2)) - 1, len(PHRASES) - 1)
        phrase = PHRASES[idx]
    yield Pick(_at(day, hour, rng), "talk", phrase)


def explorer(rng: random.Random) -> Iterator[Pick]:
    """Few routines: picks dinner almost at random with a mild favourite. A hard case for everyone."""
    weights = [3, 2, 2, 2, 1]
    for day in range(DAYS):
        yield Pick(_at(day, 19, rng), "food", rng.choices(DINNERS, weights)[0])
        if rng.random() < 0.5:
            yield Pick(_at(day, 15, rng), "call", rng.choice(CONTACTS))
        for _ in range(rng.randint(1, 4)):
            yield from _talk(rng, day)


PERSONAS: dict[str, Generator] = {
    "routine (20% noise)": lambda rng: riley(rng, noise=0.2),
    "routine (40% noise)": lambda rng: riley(rng, noise=0.4),
    "habit change at week 12": lambda rng: riley(rng, noise=0.2, change=True),
    "explorer (few habits)": explorer,
}


@dataclass
class Score:
    n: int = 0
    top1: int = 0
    top3: int = 0

    def add(self, ranked: list[str], actual: str) -> None:
        self.n += 1
        self.top1 += int(bool(ranked) and ranked[0] == actual)
        self.top3 += int(actual in ranked[:3])

    def merge(self, other: Score) -> None:
        self.n += other.n
        self.top1 += other.top1
        self.top3 += other.top3


@dataclass
class Result:
    scores: dict[str, Score] = field(default_factory=lambda: defaultdict(Score))
    usual_offered: int = 0
    usual_right: int = 0
    usual_slots: int = 0
    adaptation: dict[str, int | None] = field(default_factory=dict)


def evaluate(picks: list[Pick], params: Params) -> Result:
    picks = sorted(picks, key=lambda p: p.at)
    result = Result()
    records: list[EventRecord] = []
    by_surface: dict[str, list[Pick]] = defaultdict(list)
    friday_after: dict[str, list[bool]] = defaultdict(list)
    new_friday = "Sushi Go: salmon set"
    warmup = START + timedelta(days=WARMUP_DAYS)
    for pick in picks:
        history = by_surface[pick.surface]
        if pick.at >= warmup and history:
            occs = occasions(records)
            surface_occs = [o for o in occs if o.surface == pick.surface]
            candidates = {o.node_id for o in surface_occs}
            ours = [r.node_id for r in rank(surface_occs, candidates, pick.at, params, sequence_occasions=occs)]
            freq = [k for k, _ in Counter(p.leaf for p in history).most_common()]
            recent = list(dict.fromkeys(p.leaf for p in reversed(history)))
            for name, ranked in (("memory", ours), ("frequent", freq), ("recent", recent)):
                result.scores[name].add(ranked, pick.leaf)
                result.scores[f"{name}:{pick.surface}"].add(ranked, pick.leaf)
            # "Usual" is what gets pre-selected, so its precision matters more than its coverage.
            if pick.surface == "food":
                result.usual_slots += 1
                found = usual_of([(o, o.node_id) for o in surface_occs], Context.of(pick.at), params, pick.at)
                if found is not None:
                    result.usual_offered += 1
                    result.usual_right += int(found[0] == pick.leaf)
            if pick.surface == "food" and pick.at.weekday() == 4 and pick.at >= START + timedelta(days=CHANGE_DAY):
                friday_after["memory"].append(bool(ours) and ours[0] == new_friday)
                friday_after["frequent"].append(bool(freq) and freq[0] == new_friday)
                friday_after["recent"].append(bool(recent) and recent[0] == new_friday)
        history.append(pick)
        records.append(
            EventRecord(pick.leaf, ("root", pick.leaf), pick.surface, "chosen", "event", pick.at, pick.at.weekday(), pick.at.hour)
        )
    for name, hits in friday_after.items():
        # Fridays after the change until the predictor's first choice is the new habit and stays there.
        settled = next((i for i in range(len(hits)) if all(hits[i:])), None)
        result.adaptation[name] = None if settled is None else settled + 1
    return result


def run(seeds: range, params: Params) -> dict[str, Result]:
    totals: dict[str, Result] = {}
    for persona, gen in PERSONAS.items():
        total = Result()
        adapt: dict[str, list[int | None]] = defaultdict(list)
        for seed in seeds:
            res = evaluate(list(gen(random.Random(seed))), params)
            for name, score in res.scores.items():
                total.scores[name].merge(score)
            total.usual_offered += res.usual_offered
            total.usual_right += res.usual_right
            total.usual_slots += res.usual_slots
            for name, value in res.adaptation.items():
                adapt[name].append(value)
        for name, values in adapt.items():
            known = [v for v in values if v is not None]
            total.adaptation[name] = round(statistics.median(known)) if len(known) * 2 > len(values) else None
        totals[persona] = total
    return totals


def latency(events_per_day: int = 20, days: int = 365, queries: int = 200) -> dict[str, float]:
    """Wall-clock time of MemoryService.suggestions over SQLite with a year of history."""
    from ..db import Database
    from .clock import FakeClock
    from .models import MemorySettings, SelectionEventIn
    from .service import MemoryService

    rng = random.Random(7)
    with TemporaryDirectory() as tmp:
        db = Database(Path(tmp) / "bench.db")
        db.migrate()
        clock = FakeClock(START)
        svc = MemoryService(db, clock)
        svc.save_settings(MemorySettings(timezone="UTC"))
        surfaces = ["food", "call", "talk", "shopping", "apps"]
        with db.transaction():
            for day in range(days):
                for _ in range(events_per_day):
                    clock.set(START + timedelta(days=day, minutes=rng.randint(0, 1439)))
                    surface = rng.choice(surfaces)
                    leaf = f"{surface} option {min(int(rng.paretovariate(1.1)), 60)}"
                    svc.record(SelectionEventIn(path=[surface, "group", leaf], surface=surface, outcome="chosen"))  # type: ignore[arg-type]
        clock.set(START + timedelta(days=days))
        timings: dict[str, list[float]] = defaultdict(list)
        for i in range(queries):
            for label, fn in (
                ("suggestions(food)", lambda: svc.suggestions("food")),
                ("suggestions(home)", lambda: svc.suggestions("home")),
                ("usual(food/group)", lambda: svc.usual(["food", "group"])),
            ):
                t0 = time.perf_counter()
                fn()
                timings[label].append((time.perf_counter() - t0) * 1000)
            if i == 0:
                timings.clear()  # first call warms caches
        out: dict[str, float] = {"events": float(svc.store.counts()["events"])}
        for label, values in timings.items():
            values.sort()
            out[f"{label} p50"] = values[len(values) // 2]
            out[f"{label} p95"] = values[int(len(values) * 0.95)]
        return out


def pct(a: int, b: int) -> str:
    return f"{100 * a / b:.1f}%" if b else "n/a"


def markdown(totals: dict[str, Result]) -> str:
    lines = [
        "| Persona | Predictions | memory top-1 | memory top-3 | frequent top-1 | frequent top-3 | recent top-1 | recent top-3 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for persona, res in totals.items():
        s = res.scores
        lines.append(
            f"| {persona} | {s['memory'].n} | **{pct(s['memory'].top1, s['memory'].n)}** | **{pct(s['memory'].top3, s['memory'].n)}** "
            f"| {pct(s['frequent'].top1, s['frequent'].n)} | {pct(s['frequent'].top3, s['frequent'].n)} "
            f"| {pct(s['recent'].top1, s['recent'].n)} | {pct(s['recent'].top3, s['recent'].n)} |"
        )
    lines += [
        "",
        "By surface, all personas together:",
        "",
        "| Surface | Predictions | memory top-1 | memory top-3 | frequent top-1 | frequent top-3 | recent top-1 | recent top-3 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    merged: dict[str, Score] = defaultdict(Score)
    for res in totals.values():
        for key, score in res.scores.items():
            merged[key].merge(score)
    for surface in sorted({k.split(":")[1] for k in merged if ":" in k}):
        m, f, r = (merged[f"{n}:{surface}"] for n in ("memory", "frequent", "recent"))
        lines.append(
            f"| {surface} | {m.n} | **{pct(m.top1, m.n)}** | **{pct(m.top3, m.n)}** | {pct(f.top1, f.n)} | {pct(f.top3, f.n)} "
            f"| {pct(r.top1, r.n)} | {pct(r.top3, r.n)} |"
        )
    lines += [
        "",
        "| Persona | Dinners where a usual was offered | Usual was right |",
        "|---|---:|---:|",
    ]
    for persona, res in totals.items():
        lines.append(f"| {persona} | {pct(res.usual_offered, res.usual_slots)} | {pct(res.usual_right, res.usual_offered)} |")
    change = totals.get("habit change at week 12")
    if change is not None:
        lines += ["", "| Predictor | Fridays until the new habit is first (median) |", "|---|---:|"]
        for name in ("memory", "frequent", "recent"):
            value = change.adaptation.get(name)
            lines.append(f"| {name} | {value if value is not None else 'not within the run'} |")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seeds", default="100-119", help="seed range, e.g. 0-4 (tuning) or 100-119 (held out)")
    parser.add_argument("--half-life", type=float, default=30.0)
    parser.add_argument("--markdown", action="store_true")
    parser.add_argument("--latency", action="store_true")
    args = parser.parse_args()
    lo, hi = (int(x) for x in args.seeds.split("-"))
    params = Params(half_life_days=args.half_life)
    started = time.perf_counter()
    totals = run(range(lo, hi + 1), params)
    print(f"seeds {lo}-{hi}, half-life {args.half_life} days, {time.perf_counter() - started:.1f}s\n")
    if args.markdown:
        print(markdown(totals))
    else:
        for persona, res in totals.items():
            print(persona)
            for name, s in res.scores.items():
                if ":" in name:
                    continue
                print(f"  {name:9} top-1 {pct(s.top1, s.n):>6}  top-3 {pct(s.top3, s.n):>6}  (n={s.n})")
            print(f"  usual offered {pct(res.usual_offered, res.usual_slots)}, right {pct(res.usual_right, res.usual_offered)}")
            if res.adaptation:
                print(f"  adaptation (Fridays): {res.adaptation}")
    if args.latency:
        print()
        for key, value in latency().items():
            print(f"{key}: {value:.2f}")


if __name__ == "__main__":
    main()
