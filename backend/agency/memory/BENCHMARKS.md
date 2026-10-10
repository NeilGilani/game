# Memory tree: how well it predicts

**These are results on synthetic personas. No real person's choices have been measured.** The
numbers say the learner beats simple baselines on generated routines with noise. They do not say how
often real people with ALS or locked-in syndrome will see the right thing first. That needs a study
with real (consenting) users, which hasn't happened.

Reproduce (about 50 seconds on the machine below):

```
cd backend && .venv/bin/python -m agency.memory.bench --seeds 100-119 --markdown --latency
```

Measured on 10 October 2026, Apple M5 Pro, macOS, Python 3.12.14, with the defaults in
`learning.Params` (30-day half-life, back-off pseudo-count 2, usual = at least 3 of the last 5 in at
least 4 occasions, holding at least 60% of the recency-weighted history in that context).

## Method

* **Personas** (`bench.py`), 140 days each, 20 random seeds per persona:
  * *routine*: weekday lunches (soup Monday to Wednesday, a sandwich Thursday and Friday), Friday Thai,
    weekend pizza, home cooking on other evenings (twice the base noise), a Sunday morning call to
    Mum, a pharmacy call every two weeks usually followed by a call to Jordan, weekly groceries, and
    2 to 5 Talk phrases a day ("Good morning" in the morning, "Good night" at night, otherwise a
    long-tailed choice from 30 phrases). Noise is 20% or 40%: that share of choices is random.
  * *habit change*: the 20% persona whose Friday dinner switches from Thai to sushi in week 12.
  * *explorer*: few habits. Dinner is a weighted random pick (favourite 30%), random calls, phrases.
* **Replay**: every selection is replayed in time order after a 14-day warm-up. Before each one,
  each predictor ranks the options already seen on that surface, using only earlier selections.
  *Top-1* means the actual choice was ranked first (one look); *top-3* means it was on the first
  three tiles.
* **Baselines**: *frequent* ranks by how often each option was chosen on that surface; *recent*
  ranks by how recently.
* **Tuning and testing are separate**: parameters were chosen on seeds 0 to 4 (half-life 14, 30, 60
  days; usual share 0.5, 0.6, 0.7; minimum history 3 or 4). Everything below is on seeds 100 to 119,
  which were not used for tuning.

## Top-1 and top-3 hit rates (held-out seeds 100 to 119)

| Persona | Predictions | memory top-1 | memory top-3 | frequent top-1 | frequent top-3 | recent top-1 | recent top-3 |
|---|---:|---:|---:|---:|---:|---:|---:|
| routine (20% noise) | 13875 | **58.9%** | **82.5%** | 35.3% | 70.7% | 20.0% | 53.5% |
| routine (40% noise) | 13863 | **50.8%** | **78.3%** | 32.5% | 65.4% | 18.5% | 49.9% |
| habit change at week 12 | 13875 | **58.4%** | **82.5%** | 35.3% | 70.7% | 20.0% | 53.5% |
| explorer (few habits) | 10042 | **38.4%** | **73.5%** | 33.5% | 68.4% | 22.0% | 58.2% |

By surface, all personas together:

| Surface | Predictions | memory top-1 | memory top-3 | frequent top-1 | frequent top-3 | recent top-1 | recent top-3 |
|---|---:|---:|---:|---:|---:|---:|---:|
| call | 3426 | **55.2%** | **79.0%** | 26.9% | 76.1% | 18.5% | 66.6% |
| food | 14400 | **60.8%** | **83.0%** | 22.3% | 63.1% | 10.1% | 44.7% |
| shopping | 1080 | 70.3% | 93.3% | 70.8% | 93.3% | 61.2% | 93.3% |
| talk | 32749 | **48.1%** | **77.7%** | 39.0% | 69.8% | 23.1% | 54.6% |

What this means: the biggest gain is where context matters (food: 61% first-look hits against 22%
for "most frequent", because Friday dinner and Monday lunch are different questions) and where
sequences matter (calls: after the pharmacy, Jordan). Shopping has one dominant habit, so counting is
as good as anything; the learner is no better there (70.3% against 70.8%, within noise). For the
explorer, whose choices are close to random, nothing predicts well and the gain is small.

## The "usual" (what gets pre-selected)

A usual is pre-selected in flows and in the agent's questions, so being wrong costs a person who
can't easily undo a mistake. The gate is deliberately strict, and we report how often it fires and
how often it is right:

| Persona | Dinners where a usual was offered | Usual was right |
|---|---:|---:|
| routine (20% noise) | 76.3% | 78.5% |
| routine (40% noise) | 44.3% | 66.5% |
| habit change at week 12 | 74.2% | 77.0% |
| explorer (few habits) | 5.5% | 19.4% |

For the routine personas, the ceiling on "right" is set by the noise itself (a random pick can't be
predicted). The explorer row is the honest weak spot: a usual still appears on about 1 dinner in 18,
and is usually wrong. On the tuning seeds, a looser gate (share 0.5, three occasions) offered a usual
on 16.7% of the explorer's dinners; the current gate cut that to 5.9%, at the cost of offering fewer
usuals to the routine personas (from 85% to 78% of dinners). The interface makes a wrong usual cheap:
it's one tile among the choices, never chosen automatically, and *Forget* or *Not this* removes it.

## Adapting when a habit changes

The *habit change* persona switches Friday dinner from Thai to sushi in week 12. We count the Fridays
after the change until a predictor's first choice for Friday dinner is sushi and stays sushi for the
rest of the run (median over seeds):

| Predictor | Fridays until the new habit is first (median) |
|---|---:|
| memory (30-day half-life) | 5 |
| frequent | not within the 8 Fridays of the run |
| recent | not within the run (it flips back after every noisy pick) |

On the tuning seeds, a 14-day half-life adapted in 4 Fridays and a 60-day half-life in 6, with
top-1 accuracy within about 1 point of the 30-day default. The half-life is a setting the person (or
their helper) can change.

## Latency

`MemoryService` over SQLite with one year of history (7,300 events, 20 a day across 5 surfaces,
about 60 options per surface), 199 timed calls each after one warm-up call, on the machine above:

| Call | p50 | p95 |
|---|---:|---:|
| `suggestions(food)` | 35 ms | 52 ms |
| `suggestions(home)` | 46 ms | 68 ms |
| `usual(food/group)` | 30 ms | 47 ms |

This is in-process, without HTTP. Each call re-reads the events inside the horizon (8 half-lives,
240 days by default) and recomputes; there is no cache yet. On a Raspberry Pi 4 it will be several
times slower; that hasn't been measured.

## Not measured

* Real users, real routines, and whether these suggestions actually save looks in practice.
* Rejection handling in the benchmark (the replay never rejects a suggestion; rejections are
  covered by unit tests only).
* Keyboard word prediction quality (unit-tested for prefix filtering, not benchmarked).
* Encrypted-database latency and Raspberry Pi latency.
