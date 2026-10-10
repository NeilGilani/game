# Gaze engine benchmarks

All numbers on this page were produced by the commands below on 2026-10-10. Accuracy, precision, selection, reading
and drift numbers are **simulated** (synthetic face and eyes, `src/synth/`); no real person has been measured. Speed
numbers are real, measured in Chromium on an Apple M5 Pro with a fake camera. See README.md for the summary and for
what was not measured.

- Simulated: `cd os/gaze && npm run bench` (Node 26.8.2, darwin arm64, 10 simulated people per row, ~70 s). Raw
  data: `bench/results/pipeline.json`; tables: `bench/results/pipeline.md`.
- Real speed: `make e2e-fixtures && cd os/gaze && npm run bench:browser`. Raw data: `bench/results/browser-*.json`.
- Unit, replay and fake-camera tests: `npm run check -w @agency/gaze`, `npm run test:e2e -w @agency/gaze`.

Definitions: accuracy = distance from the mean output during a fixation (from 300 ms after onset) to the true
point; precision = RMS of the output around that mean; settle = median time after a >300 pt saccade until the
output is within 100 pt of where it settles; usable = share of fixation frames with confidence ≥ 0.5; degrees use
the true eye-to-target distance. "Raw precision" is before smoothing. v1 = current web-app pipeline, v2 = this engine.

## Accuracy and precision (simulated, look-around after calibration)

| noise   | head    | pipeline | accuracy pt (sd) | accuracy deg | precision pt | precision deg | raw precision pt | settle ms | usable | calib. reported pt / deg | training points |
| ------- | ------- | -------- | ---------------- | ------------ | ------------ | ------------- | ---------------- | --------- | ------ | ------------------------ | --------------- |
| low     | still   | v1       | 43 (6)           | 0.80         | 82           | 1.52          | 117              | 81        | 97%    | -                        | 9.0             |
| low     | still   | v2       | 35 (11)          | 0.65         | 21           | 0.39          | 124              | 87        | 97%    | 31 / 0.60                | 9.0             |
| low     | natural | v1       | 70 (18)          | 1.30         | 78           | 1.45          | 112              | 75        | 97%    | -                        | 9.0             |
| low     | natural | v2       | 44 (5)           | 0.81         | 20           | 0.38          | 124              | 83        | 97%    | 45 / 0.85                | 9.3             |
| low     | moving  | v1       | 93 (16)          | 1.71         | 77           | 1.43          | 110              | 76        | 97%    | -                        | 9.0             |
| low     | moving  | v2       | 53 (16)          | 0.99         | 20           | 0.38          | 122              | 84        | 97%    | 51 / 0.96                | 11.5            |
| typical | still   | v1       | 95 (9)           | 1.77         | 153          | 2.84          | 200              | 128       | 97%    | -                        | 9.0             |
| typical | still   | v2       | 69 (6)           | 1.28         | 46           | 0.85          | 242              | 174       | 97%    | 44 / 0.84                | 14.0            |
| typical | natural | v1       | 135 (29)         | 2.49         | 144          | 2.67          | 189              | 114       | 97%    | -                        | 9.0             |
| typical | natural | v2       | 77 (9)           | 1.43         | 45           | 0.84          | 239              | 169       | 97%    | 55 / 1.06                | 14.1            |
| typical | moving  | v1       | 152 (32)         | 2.81         | 140          | 2.60          | 185              | 116       | 97%    | -                        | 9.0             |
| typical | moving  | v2       | 94 (11)          | 1.74         | 46           | 0.85          | 236              | 182       | 97%    | 86 / 1.66                | 14.5            |
| high    | still   | v1       | 199 (18)         | 3.67         | 218          | 4.04          | 270              | 179       | 97%    | -                        | 9.0             |
| high    | still   | v2       | 160 (20)         | 2.96         | 113          | 2.10          | 425              | 387       | 96%    | 126 / 2.42               | 13.7            |
| high    | natural | v1       | 233 (33)         | 4.31         | 209          | 3.88          | 260              | 178       | 97%    | -                        | 9.0             |
| high    | natural | v2       | 165 (28)         | 3.05         | 117          | 2.16          | 431              | 361       | 95%    | 135 / 2.59               | 14.1            |
| high    | moving  | v1       | 267 (41)         | 4.93         | 198          | 3.67          | 246              | 157       | 97%    | -                        | 9.0             |
| high    | moving  | v2       | 197 (36)         | 3.67         | 106          | 1.95          | 398              | 335       | 96%    | 179 / 3.45               | 14.0            |

## False activations per minute while reading (page fully covered by 96 pt targets, 24 pt gaps)

| head    | v1 per min | v2 per min | minutes simulated per pipeline |
| ------- | ---------- | ---------- | ------------------------------ |
| still   | 0.00       | 0.05       | 21.7                           |
| natural | 0.00       | 0.00       | 21.7                           |
| moving  | 0.00       | 0.05       | 21.7                           |

## Selection (dwell 1200 ms, snap 48 pt, grid of same-size targets, 8 s limit)

| head    | target pt | pipeline     | correct | wrong | timeouts | median time ms | p90 time ms | picker or magnifier shown |
| ------- | --------- | ------------ | ------- | ----- | -------- | -------------- | ----------- | ------------------------- |
| still   | 48        | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| still   | 48        | v2           | 17%     | 23%   | 60%      | 4630           | 7259        | 0                         |
| still   | 48        | v2 + helpers | 72%     | 3%    | 25%      | 2805           | 4459        | 107                       |
| still   | 96        | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| still   | 96        | v2           | 85%     | 15%   | 0%       | 2855           | 5807        | 0                         |
| still   | 96        | v2 + helpers | 95%     | 2%    | 3%       | 2626           | 3454        | 66                        |
| still   | 120       | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| still   | 120       | v2           | 90%     | 10%   | 0%       | 2173           | 4506        | 0                         |
| still   | 120       | v2 + helpers | 98%     | 0%    | 2%       | 2643           | 3580        | 59                        |
| still   | 160       | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| still   | 160       | v2           | 98%     | 0%    | 2%       | 2017           | 2754        | 0                         |
| still   | 160       | v2 + helpers | 98%     | 2%    | 0%       | 2382           | 3299        | 39                        |
| natural | 48        | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| natural | 48        | v2           | 18%     | 30%   | 52%      | 4161           | 6256        | 0                         |
| natural | 48        | v2 + helpers | 78%     | 0%    | 22%      | 2833           | 4339        | 99                        |
| natural | 96        | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| natural | 96        | v2           | 77%     | 17%   | 7%       | 3472           | 5909        | 0                         |
| natural | 96        | v2 + helpers | 95%     | 0%    | 5%       | 2654           | 3490        | 67                        |
| natural | 120       | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| natural | 120       | v2           | 82%     | 15%   | 3%       | 2549           | 4263        | 0                         |
| natural | 120       | v2 + helpers | 95%     | 3%    | 2%       | 2644           | 3537        | 61                        |
| natural | 160       | v1           | 0%      | 0%    | 100%     | n/a            | n/a         | 0                         |
| natural | 160       | v2           | 97%     | 2%    | 2%       | 2080           | 3230        | 0                         |
| natural | 160       | v2 + helpers | 100%    | 0%    | 0%       | 2546           | 3742        | 45                        |

## Continuous recalibration while the head slumps (3 cm down, 6 cm back, 6 deg over 2 min; 120 pt targets)

| variant         | error first 30 s pt | error after 3 min pt | correct | wrong | recalibration advised |
| --------------- | ------------------- | -------------------- | ------- | ----- | --------------------- |
| v2 alone        | 58                  | 98                   | 218     | 108   | 0 of 6                |
| v2 + continuous | 51                  | 98                   | 197     | 86    | 0 of 6                |

## Real speed (Chromium, Apple M5 Pro)

Headless Chrome for Testing 153, WebGL `ANGLE Metal Renderer: Apple M5 Pro`, MediaPipe Face Landmarker 0.10.35,
fake camera 640×480 at ~31 fps (still photo), 15 s after a 2 s warm-up.

| Run                                            | fps  | camera fps | detection median | latency median / p95 | engine per frame (p95) |
| ---------------------------------------------- | ---- | ---------- | ---------------- | -------------------- | ---------------------- |
| GPU delegate                                   | 30.0 | 31         | 10.2 ms          | 23.9 / 27.8 ms       | 0.1 ms                 |
| CPU delegate                                   | 30.0 | 31         | 21.1 ms          | 24.2 / 28.0 ms       | 0.1 ms                 |
| GPU, timer scheduler (hidden window path), 6 s | 29.9 | 31         | 9.5 ms           | n/a                  | 0.1 ms                 |

Earlier runs while the machine was heavily loaded (load average 9 to 26 from other work) gave 17–29 fps on the CPU
delegate; the GPU delegate held 30 fps once the frame governor used a token bucket. Engine compute in Node is
about 0.03 ms per frame (v2) against 0.003 ms (v1); both are negligible next to landmark detection.
