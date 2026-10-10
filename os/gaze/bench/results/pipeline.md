## Accuracy and precision (simulated, look-around after calibration)
| noise | head | pipeline | accuracy pt (sd) | accuracy deg | precision pt | precision deg | raw precision pt | settle ms | usable | calib. reported pt / deg | training points |
|---|---|---|---|---|---|---|---|---|---|---|---|
| low | still | v1 | 43 (6) | 0.80 | 82 | 1.52 | 117 | 81 | 97% | - | 9.0 |
| low | still | v2 | 35 (11) | 0.65 | 21 | 0.39 | 124 | 87 | 97% | 31 / 0.60 | 9.0 |
| low | natural | v1 | 70 (18) | 1.30 | 78 | 1.45 | 112 | 75 | 97% | - | 9.0 |
| low | natural | v2 | 44 (5) | 0.81 | 20 | 0.38 | 124 | 83 | 97% | 45 / 0.85 | 9.3 |
| low | moving | v1 | 93 (16) | 1.71 | 77 | 1.43 | 110 | 76 | 97% | - | 9.0 |
| low | moving | v2 | 53 (16) | 0.99 | 20 | 0.38 | 122 | 84 | 97% | 51 / 0.96 | 11.5 |
| typical | still | v1 | 95 (9) | 1.77 | 153 | 2.84 | 200 | 128 | 97% | - | 9.0 |
| typical | still | v2 | 69 (6) | 1.28 | 46 | 0.85 | 242 | 174 | 97% | 44 / 0.84 | 14.0 |
| typical | natural | v1 | 135 (29) | 2.49 | 144 | 2.67 | 189 | 114 | 97% | - | 9.0 |
| typical | natural | v2 | 77 (9) | 1.43 | 45 | 0.84 | 239 | 169 | 97% | 55 / 1.06 | 14.1 |
| typical | moving | v1 | 152 (32) | 2.81 | 140 | 2.60 | 185 | 116 | 97% | - | 9.0 |
| typical | moving | v2 | 94 (11) | 1.74 | 46 | 0.85 | 236 | 182 | 97% | 86 / 1.66 | 14.5 |
| high | still | v1 | 199 (18) | 3.67 | 218 | 4.04 | 270 | 179 | 97% | - | 9.0 |
| high | still | v2 | 160 (20) | 2.96 | 113 | 2.10 | 425 | 387 | 96% | 126 / 2.42 | 13.7 |
| high | natural | v1 | 233 (33) | 4.31 | 209 | 3.88 | 260 | 178 | 97% | - | 9.0 |
| high | natural | v2 | 165 (28) | 3.05 | 117 | 2.16 | 431 | 361 | 95% | 135 / 2.59 | 14.1 |
| high | moving | v1 | 267 (41) | 4.93 | 198 | 3.67 | 246 | 157 | 97% | - | 9.0 |
| high | moving | v2 | 197 (36) | 3.67 | 106 | 1.95 | 398 | 335 | 96% | 179 / 3.45 | 14.0 |

## False activations per minute while reading (page fully covered by 96 pt targets, 24 pt gaps)
| head | v1 per min | v2 per min | minutes simulated per pipeline |
|---|---|---|---|
| still | 0.00 | 0.05 | 21.7 |
| natural | 0.00 | 0.00 | 21.7 |
| moving | 0.00 | 0.05 | 21.7 |

## Selection (dwell 1200 ms, snap 48 pt, grid of same-size targets, 8 s limit)
| head | target pt | pipeline | correct | wrong | timeouts | median time ms | p90 time ms | picker or magnifier shown |
|---|---|---|---|---|---|---|---|---|
| still | 48 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| still | 48 | v2 | 17% | 23% | 60% | 4630 | 7259 | 0 |
| still | 48 | v2 + helpers | 72% | 3% | 25% | 2805 | 4459 | 107 |
| still | 96 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| still | 96 | v2 | 85% | 15% | 0% | 2855 | 5807 | 0 |
| still | 96 | v2 + helpers | 95% | 2% | 3% | 2626 | 3454 | 66 |
| still | 120 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| still | 120 | v2 | 90% | 10% | 0% | 2173 | 4506 | 0 |
| still | 120 | v2 + helpers | 98% | 0% | 2% | 2643 | 3580 | 59 |
| still | 160 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| still | 160 | v2 | 98% | 0% | 2% | 2017 | 2754 | 0 |
| still | 160 | v2 + helpers | 98% | 2% | 0% | 2382 | 3299 | 39 |
| natural | 48 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| natural | 48 | v2 | 18% | 30% | 52% | 4161 | 6256 | 0 |
| natural | 48 | v2 + helpers | 78% | 0% | 22% | 2833 | 4339 | 99 |
| natural | 96 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| natural | 96 | v2 | 77% | 17% | 7% | 3472 | 5909 | 0 |
| natural | 96 | v2 + helpers | 95% | 0% | 5% | 2654 | 3490 | 67 |
| natural | 120 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| natural | 120 | v2 | 82% | 15% | 3% | 2549 | 4263 | 0 |
| natural | 120 | v2 + helpers | 95% | 3% | 2% | 2644 | 3537 | 61 |
| natural | 160 | v1 | 0% | 0% | 100% | n/a | n/a | 0 |
| natural | 160 | v2 | 97% | 2% | 2% | 2080 | 3230 | 0 |
| natural | 160 | v2 + helpers | 100% | 0% | 0% | 2546 | 3742 | 45 |

## Continuous recalibration while the head slumps (3 cm down, 6 cm back, 6 deg over 2 min; 120 pt targets)
| variant | error first 30 s pt | error after 3 min pt | correct | wrong | recalibration advised |
|---|---|---|---|---|---|
| v2 alone | 58 | 98 | 218 | 108 | 0 of 6 |
| v2 + continuous | 51 | 98 | 197 | 86 | 0 of 6 |
