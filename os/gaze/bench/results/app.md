## Pointer accuracy and steadiness (simulated, typical webcam noise, looking around)

| head | pipeline | accuracy pt | steadiness: RMS while fixating pt | settle after a jump ms | people |
|---|---|---|---|---|---|
| still | before (old app) | 96 | 92 | 174 | 8 |
| still | v2 | 80 | 51 | 219 | 8 |
| still | v2 + old stabilizer | 95 | 46 | 262 | 8 |
| natural | before (old app) | 139 | 85 | 161 | 8 |
| natural | v2 | 87 | 51 | 217 | 8 |
| natural | v2 + old stabilizer | 100 | 47 | 260 | 8 |

## Selecting a target among same-size targets (24 px gaps, dwell 1200 ms, 15 looks of up to 8 s per person and size; simulated)

| head | target px | pipeline / selection | correct | wrong | timeout | median s | p90 s | highlight changes per look | intended target highlighted |
|---|---|---|---|---|---|---|---|---|---|
| still | 96 | before (old app) / snap 48 px | 5% | 7% | 88% | 6.0 | 7.7 | 10.5 | 27% |
| still | 96 | v2 / snap 48 px | 88% | 12% | 0% | 2.5 | 5.1 | 2.6 | 68% |
| still | 96 | v2 / magnet, steadiness: pointer | 88% | 11% | 2% | 2.7 | 5.7 | 2.4 | 66% |
| still | 96 | v2 / magnet, steadiness: adaptive | 88% | 11% | 2% | 2.7 | 5.7 | 2.4 | 66% |
| still | 96 | v2 / magnet, steadiness: lock | 88% | 11% | 2% | 2.7 | 5.7 | 2.4 | 66% |
| still | 96 | v2 + old stabilizer / magnet, steadiness: pointer | 85% | 15% | 0% | 2.7 | 5.3 | 2.4 | 58% |
| still | 96 | v2 + old stabilizer / magnet, steadiness: lock | 85% | 15% | 0% | 2.7 | 5.3 | 2.4 | 58% |
| still | 120 | before (old app) / snap 48 px | 4% | 7% | 89% | 4.4 | 6.8 | 8.6 | 31% |
| still | 120 | v2 / snap 48 px | 88% | 10% | 3% | 2.4 | 4.6 | 2.4 | 71% |
| still | 120 | v2 / magnet, steadiness: pointer | 88% | 11% | 2% | 2.5 | 4.5 | 2.1 | 69% |
| still | 120 | v2 / magnet, steadiness: adaptive | 88% | 11% | 2% | 2.5 | 4.4 | 2.1 | 68% |
| still | 120 | v2 / magnet, steadiness: lock | 88% | 11% | 2% | 2.5 | 4.4 | 2.1 | 68% |
| still | 120 | v2 + old stabilizer / magnet, steadiness: pointer | 88% | 12% | 1% | 2.6 | 5.0 | 2.1 | 63% |
| still | 120 | v2 + old stabilizer / magnet, steadiness: lock | 88% | 12% | 1% | 2.6 | 5.0 | 2.1 | 63% |
| still | 160 | before (old app) / snap 48 px | 14% | 3% | 83% | 6.2 | 7.4 | 6.5 | 52% |
| still | 160 | v2 / snap 48 px | 96% | 4% | 0% | 2.0 | 2.7 | 1.5 | 84% |
| still | 160 | v2 / magnet, steadiness: pointer | 99% | 1% | 0% | 2.0 | 3.1 | 1.8 | 82% |
| still | 160 | v2 / magnet, steadiness: adaptive | 99% | 1% | 0% | 1.9 | 2.7 | 1.8 | 82% |
| still | 160 | v2 / magnet, steadiness: lock | 99% | 1% | 0% | 1.9 | 2.7 | 1.8 | 82% |
| still | 160 | v2 + old stabilizer / magnet, steadiness: pointer | 98% | 3% | 0% | 2.1 | 3.5 | 1.8 | 77% |
| still | 160 | v2 + old stabilizer / magnet, steadiness: lock | 98% | 3% | 0% | 2.0 | 3.5 | 1.8 | 77% |
| natural | 96 | before (old app) / snap 48 px | 4% | 6% | 90% | 6.0 | 6.9 | 10.0 | 20% |
| natural | 96 | v2 / snap 48 px | 77% | 18% | 5% | 2.5 | 5.4 | 2.7 | 60% |
| natural | 96 | v2 / magnet, steadiness: pointer | 76% | 19% | 5% | 3.0 | 5.6 | 2.4 | 53% |
| natural | 96 | v2 / magnet, steadiness: adaptive | 76% | 19% | 5% | 2.8 | 5.6 | 2.4 | 52% |
| natural | 96 | v2 / magnet, steadiness: lock | 76% | 19% | 5% | 2.8 | 5.6 | 2.4 | 52% |
| natural | 96 | v2 + old stabilizer / magnet, steadiness: pointer | 73% | 23% | 3% | 3.2 | 5.2 | 2.4 | 47% |
| natural | 96 | v2 + old stabilizer / magnet, steadiness: lock | 73% | 23% | 3% | 3.2 | 5.2 | 2.4 | 47% |
| natural | 120 | before (old app) / snap 48 px | 5% | 12% | 83% | 6.2 | 7.4 | 7.7 | 20% |
| natural | 120 | v2 / snap 48 px | 82% | 14% | 4% | 2.4 | 4.7 | 2.5 | 67% |
| natural | 120 | v2 / magnet, steadiness: pointer | 83% | 13% | 3% | 2.7 | 5.7 | 2.2 | 63% |
| natural | 120 | v2 / magnet, steadiness: adaptive | 84% | 13% | 3% | 2.7 | 5.5 | 2.2 | 63% |
| natural | 120 | v2 / magnet, steadiness: lock | 84% | 13% | 3% | 2.7 | 5.5 | 2.2 | 63% |
| natural | 120 | v2 + old stabilizer / magnet, steadiness: pointer | 78% | 19% | 3% | 2.8 | 5.2 | 2.2 | 56% |
| natural | 120 | v2 + old stabilizer / magnet, steadiness: lock | 78% | 19% | 3% | 2.8 | 5.2 | 2.2 | 55% |
| natural | 160 | before (old app) / snap 48 px | 11% | 17% | 73% | 6.0 | 7.6 | 5.8 | 34% |
| natural | 160 | v2 / snap 48 px | 91% | 8% | 1% | 2.0 | 3.4 | 1.6 | 79% |
| natural | 160 | v2 / magnet, steadiness: pointer | 94% | 6% | 0% | 2.1 | 3.9 | 1.8 | 77% |
| natural | 160 | v2 / magnet, steadiness: adaptive | 94% | 6% | 0% | 2.0 | 3.8 | 1.8 | 77% |
| natural | 160 | v2 / magnet, steadiness: lock | 93% | 7% | 0% | 2.0 | 3.8 | 1.7 | 77% |
| natural | 160 | v2 + old stabilizer / magnet, steadiness: pointer | 94% | 6% | 0% | 2.2 | 4.1 | 1.8 | 73% |
| natural | 160 | v2 + old stabilizer / magnet, steadiness: lock | 94% | 6% | 0% | 2.2 | 4.1 | 1.8 | 73% |

## Selections nobody wanted while reading (three pages of text under a grid of 96 px targets; simulated)

| head | pipeline / selection | per minute | minutes |
|---|---|---|---|
| still | before (old app) / snap 48 px | 0.00 | 17.4 |
| still | v2 / snap 48 px | 0.00 | 17.4 |
| still | v2 / magnet, steadiness: pointer | 0.00 | 17.4 |
| still | v2 / magnet, steadiness: adaptive | 0.00 | 17.4 |
| still | v2 / magnet, steadiness: lock | 0.00 | 17.4 |
| still | v2 + old stabilizer / magnet, steadiness: pointer | 0.00 | 17.4 |
| still | v2 + old stabilizer / magnet, steadiness: lock | 0.00 | 17.4 |
| natural | before (old app) / snap 48 px | 0.00 | 17.4 |
| natural | v2 / snap 48 px | 0.00 | 17.4 |
| natural | v2 / magnet, steadiness: pointer | 0.06 | 17.4 |
| natural | v2 / magnet, steadiness: adaptive | 0.06 | 17.4 |
| natural | v2 / magnet, steadiness: lock | 0.06 | 17.4 |
| natural | v2 + old stabilizer / magnet, steadiness: pointer | 0.00 | 17.4 |
| natural | v2 + old stabilizer / magnet, steadiness: lock | 0.12 | 17.4 |
