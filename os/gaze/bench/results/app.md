## Pointer accuracy and steadiness (simulated, typical webcam noise, looking around)

| head | pipeline | accuracy pt | steadiness: RMS while fixating pt | settle after a jump ms | people |
|---|---|---|---|---|---|
| still | before (old app) | 104 | 96 | 186 | 3 |
| still | v2 | 76 | 50 | 178 | 3 |
| still | v2 + old stabilizer | 87 | 41 | 214 | 3 |
| natural | before (old app) | 160 | 87 | 162 | 3 |
| natural | v2 | 86 | 48 | 151 | 3 |
| natural | v2 + old stabilizer | 96 | 39 | 208 | 3 |

## Selecting a target among same-size targets (24 px gaps, dwell 1200 ms, 10 looks of up to 8 s per person and size; simulated)

| head | target px | pipeline / selection | correct | wrong | timeout | median s | p90 s | highlight changes per look | intended target highlighted |
|---|---|---|---|---|---|---|---|---|---|
| still | 96 | before (old app) / snap 48 px | 0% | 0% | 100% | n/a | n/a | 13.9 | 22% |
| still | 96 | v2 / snap 48 px | 90% | 10% | 0% | 2.1 | 5.5 | 2.0 | 78% |
| still | 96 | v2 / magnet, steadiness: pointer | 83% | 17% | 0% | 2.0 | 2.7 | 1.6 | 74% |
| still | 96 | v2 / magnet, steadiness: adaptive | 80% | 20% | 0% | 2.0 | 2.5 | 1.5 | 72% |
| still | 96 | v2 / magnet, steadiness: lock | 77% | 23% | 0% | 2.0 | 2.5 | 1.4 | 71% |
| still | 96 | v2 + old stabilizer / magnet, steadiness: pointer | 83% | 17% | 0% | 2.2 | 3.2 | 1.8 | 67% |
| still | 96 | v2 + old stabilizer / magnet, steadiness: lock | 80% | 20% | 0% | 2.1 | 3.2 | 1.7 | 67% |
| still | 120 | before (old app) / snap 48 px | 7% | 3% | 90% | 4.3 | 6.3 | 10.6 | 38% |
| still | 120 | v2 / snap 48 px | 90% | 10% | 0% | 2.3 | 7.3 | 2.6 | 72% |
| still | 120 | v2 / magnet, steadiness: pointer | 83% | 17% | 0% | 2.3 | 3.2 | 1.8 | 66% |
| still | 120 | v2 / magnet, steadiness: adaptive | 83% | 17% | 0% | 2.3 | 3.2 | 1.8 | 66% |
| still | 120 | v2 / magnet, steadiness: lock | 83% | 17% | 0% | 2.3 | 3.2 | 1.8 | 66% |
| still | 120 | v2 + old stabilizer / magnet, steadiness: pointer | 73% | 27% | 0% | 2.1 | 2.9 | 1.6 | 59% |
| still | 120 | v2 + old stabilizer / magnet, steadiness: lock | 70% | 30% | 0% | 2.1 | 2.9 | 1.5 | 57% |
| still | 160 | before (old app) / snap 48 px | 17% | 0% | 83% | 5.4 | 5.8 | 7.7 | 59% |
| still | 160 | v2 / snap 48 px | 93% | 7% | 0% | 2.1 | 4.1 | 1.6 | 78% |
| still | 160 | v2 / magnet, steadiness: pointer | 93% | 7% | 0% | 2.1 | 2.9 | 1.4 | 78% |
| still | 160 | v2 / magnet, steadiness: adaptive | 93% | 7% | 0% | 2.0 | 2.9 | 1.4 | 78% |
| still | 160 | v2 / magnet, steadiness: lock | 93% | 7% | 0% | 2.0 | 2.7 | 1.4 | 78% |
| still | 160 | v2 + old stabilizer / magnet, steadiness: pointer | 93% | 7% | 0% | 2.1 | 3.2 | 1.5 | 76% |
| still | 160 | v2 + old stabilizer / magnet, steadiness: lock | 93% | 7% | 0% | 2.1 | 3.1 | 1.4 | 76% |
| natural | 96 | before (old app) / snap 48 px | 0% | 0% | 100% | n/a | n/a | 12.7 | 18% |
| natural | 96 | v2 / snap 48 px | 73% | 20% | 7% | 2.4 | 5.1 | 2.6 | 64% |
| natural | 96 | v2 / magnet, steadiness: pointer | 73% | 27% | 0% | 2.1 | 3.7 | 1.9 | 60% |
| natural | 96 | v2 / magnet, steadiness: adaptive | 70% | 30% | 0% | 2.1 | 3.7 | 1.9 | 58% |
| natural | 96 | v2 / magnet, steadiness: lock | 70% | 30% | 0% | 2.1 | 3.7 | 1.9 | 58% |
| natural | 96 | v2 + old stabilizer / magnet, steadiness: pointer | 70% | 30% | 0% | 2.1 | 3.5 | 1.7 | 55% |
| natural | 96 | v2 + old stabilizer / magnet, steadiness: lock | 67% | 33% | 0% | 2.1 | 3.0 | 1.6 | 55% |
| natural | 120 | before (old app) / snap 48 px | 0% | 3% | 97% | 4.5 | 4.5 | 10.1 | 22% |
| natural | 120 | v2 / snap 48 px | 83% | 17% | 0% | 2.6 | 5.5 | 2.4 | 69% |
| natural | 120 | v2 / magnet, steadiness: pointer | 77% | 23% | 0% | 2.0 | 4.8 | 1.9 | 62% |
| natural | 120 | v2 / magnet, steadiness: adaptive | 77% | 23% | 0% | 2.1 | 4.8 | 2.0 | 59% |
| natural | 120 | v2 / magnet, steadiness: lock | 77% | 23% | 0% | 2.0 | 4.8 | 1.9 | 61% |
| natural | 120 | v2 + old stabilizer / magnet, steadiness: pointer | 77% | 23% | 0% | 2.3 | 4.9 | 1.9 | 59% |
| natural | 120 | v2 + old stabilizer / magnet, steadiness: lock | 77% | 23% | 0% | 1.9 | 4.7 | 1.7 | 61% |
| natural | 160 | before (old app) / snap 48 px | 13% | 7% | 80% | 5.8 | 6.9 | 7.7 | 41% |
| natural | 160 | v2 / snap 48 px | 90% | 10% | 0% | 2.4 | 4.0 | 1.7 | 78% |
| natural | 160 | v2 / magnet, steadiness: pointer | 93% | 7% | 0% | 2.2 | 3.9 | 1.7 | 74% |
| natural | 160 | v2 / magnet, steadiness: adaptive | 87% | 13% | 0% | 2.1 | 3.1 | 1.6 | 71% |
| natural | 160 | v2 / magnet, steadiness: lock | 87% | 13% | 0% | 2.1 | 3.1 | 1.6 | 71% |
| natural | 160 | v2 + old stabilizer / magnet, steadiness: pointer | 83% | 17% | 0% | 2.2 | 3.4 | 1.7 | 67% |
| natural | 160 | v2 + old stabilizer / magnet, steadiness: lock | 83% | 17% | 0% | 2.2 | 3.4 | 1.7 | 67% |

## Selections nobody wanted while reading (three pages of text under a grid of 96 px targets; simulated)

| head | pipeline / selection | per minute | minutes |
|---|---|---|---|
| still | before (old app) / snap 48 px | 0.00 | 6.5 |
| still | v2 / snap 48 px | 0.15 | 6.5 |
| still | v2 / magnet, steadiness: pointer | 0.31 | 6.5 |
| still | v2 / magnet, steadiness: adaptive | 1.39 | 6.5 |
| still | v2 / magnet, steadiness: lock | 1.69 | 6.5 |
| still | v2 + old stabilizer / magnet, steadiness: pointer | 0.31 | 6.5 |
| still | v2 + old stabilizer / magnet, steadiness: lock | 3.08 | 6.5 |
| natural | before (old app) / snap 48 px | 0.00 | 6.5 |
| natural | v2 / snap 48 px | 0.00 | 6.5 |
| natural | v2 / magnet, steadiness: pointer | 0.15 | 6.5 |
| natural | v2 / magnet, steadiness: adaptive | 1.23 | 6.5 |
| natural | v2 / magnet, steadiness: lock | 2.31 | 6.5 |
| natural | v2 + old stabilizer / magnet, steadiness: pointer | 0.31 | 6.5 |
| natural | v2 + old stabilizer / magnet, steadiness: lock | 3.85 | 6.5 |
