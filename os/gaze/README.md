# @agency/gaze: the AGENCY OS gaze engine

Eye tracking with an ordinary laptop webcam, for people who can move only their eyes. Camera → MediaPipe Face
Landmarker → gaze in **global screen points**, published as contract `GazeEvent`s (`@agency/contracts`). Camera
frames are processed in memory in the engine window and never stored or sent anywhere. Owned by Instance 2.

> **Honesty first.** Every accuracy, precision and selection number below comes from a **simulated** person (a
> geometric 3D face and eye model with realistic noise), not from real people. **No real user has been measured
> yet.** Speed numbers (frames per second, latency) are real, measured in Chromium on one Mac with a fake camera
> playing a still photo. Read the "What was not measured" section before quoting anything.

## What's in the package

| Area                     | Files                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                   | `src/engine.ts`, `src/host.ts`                                                  | Provider frames in, `GazeEvent`s out; `startEngineHost` wires the hidden window (commands in, events out)                                                                                                                                                                                                                                                                                                                                                                        |
| Engine page              | `engine/` → `dist/engine.html`                                                  | Loaded by the desktop app at `agency://gaze/engine.html`; MediaPipe assets are local (no CDN)                                                                                                                                                                                                                                                                                                                                                                                    |
| Features                 | `src/landmarks.ts`                                                              | Iris and eye features, head pose, **head-pose normalisation** from the facial transformation matrix, iris diameter                                                                                                                                                                                                                                                                                                                                                               |
| Calibration v2           | `src/calibration/*`                                                             | 9 to 16 adaptive points; left, right, binocular and fused per-eye models; a physics-based eye-ray model; leave-one-target-out cross-validation over degree (1–3) and ridge strength with the one-standard-error rule; outlier rejection; held-out validation in **points and degrees** (viewing distance from the 11.7 mm iris); honest good / fair / poor grades                                                                                                                |
| Eye images (RealEye)     | `src/eyeImage.ts`, `src/calibration/appearance.ts`                              | RealEye Webcam EyeTracker Light Open's extractor (two 40x20 grey eye crops and 30 landmark coordinates per frame, read from a small region around the eyes) and their kind of ridge model, fitted on the 5-second scan. Cross-validation on held-out stretches of the scan picks the ridge strength and the blend with the landmark model; the eye images are used only when they beat the landmarks alone by 3 % (AGPL-3.0 or RealEye's commercial license, see THIRD_PARTY.md) |
| Continuous recalibration | `src/calibration/continuous.ts`                                                 | Confirmed (not undone) selections become weighted samples for a bounded correction; an update is applied only if it beats the current one on held-out selections; quality is tracked; advises a clean recalibration when it drops                                                                                                                                                                                                                                                |
| Fixations and smoothing  | `src/fixation.ts`                                                               | Multi-scale dispersion test (I-DT family) with a learned noise level; output is the fixation's trimmed mean (steady) and jumps on saccades (no slide); I-VT labeller for comparison                                                                                                                                                                                                                                                                                              |
| Confidence               | `src/engine.ts`                                                                 | Below 0.5 means "don't dwell": face, eyes open, pose, saccade frames, off the calibrated display                                                                                                                                                                                                                                                                                                                                                                                 |
| Precision helpers        | `src/precision.ts`                                                              | Per-target probability under the measured error → direct, a "which one?" picker (big labelled buttons, ≥96 pt, 24 pt gaps, "None of these"), or a 2–4× magnifier with mapping back                                                                                                                                                                                                                                                                                               |
| Intent and Gaze lab      | `src/input/intent.ts`, `src/lab.ts`                                             | Gaze likelihood × context prior (`chooseTarget`, `IntentSelector`), heading prediction, precision meter for adaptive layout; the Gaze lab's 9-dot metrics, filter replay and tuning, lock suggestions, anonymous export. See "Context, prediction and the Gaze lab" below                                                                                                                                                                                                        |
| Switches and signals     | `src/blink.ts`, `src/helpPattern.ts`, `src/headPointer.ts`                      | Long-blink switch, head pointer, Lifeline's three-long-blink help pattern (moved here unchanged, same tests) emitting `help-progress` and `help-signal`                                                                                                                                                                                                                                                                                                                          |
| Providers                | `src/providers/*`                                                               | Webcam (MediaPipe injected; video-frame or timer scheduling for hidden windows), mouse, replay, external-tracker adapter (interface only: no hardware implemented)                                                                                                                                                                                                                                                                                                               |
| Record and replay        | `src/record.ts`                                                                 | Landmarks only (by default just the ~20 the pipeline reads), opt-in (`consent` must be `true`), never video                                                                                                                                                                                                                                                                                                                                                                      |
| Synthetic person         | `src/synth/*`                                                                   | 3D face, eyeballs, kappa angle, head motion, blinks, reading, renders MediaPipe-shaped output with ground truth                                                                                                                                                                                                                                                                                                                                                                  |
| Web app                  | `frontend/src/vision`, `frontend/src/input`, `frontend/src/lifeline/pattern.ts` | Thin re-exports; the web app's behaviour is unchanged (it still uses the v1 calibration and One Euro pointer)                                                                                                                                                                                                                                                                                                                                                                    |

Lifeline first: the help pattern runs on every face frame in every mode, calibrated or not, paused or not. Until a
calibration exists, `engine.html` publishes only `help-signal` (see `INTEGRATION_REQUEST.md` §1 for why).

## Results

v1 is the current web-app pipeline exactly as it runs today (9-point legacy calibration, One Euro pointer, default
preferences). v2 is this engine. Both see **identical simulated frames**: 10 simulated people per row, 640×480
camera, MacBook Air 13-inch display geometry, viewing distance about 60 cm. "Typical" noise is 0.8 px of iris jitter.
Full tables: [BENCHMARKS.md](BENCHMARKS.md).

**Accuracy and precision while looking around after calibration (simulated, typical noise)**

| Head                 | v1 accuracy    | v2 accuracy   | v1 precision (shake) | v2 precision  |
| -------------------- | -------------- | ------------- | -------------------- | ------------- |
| Still                | 95 pt (1.77°)  | 69 pt (1.28°) | 153 pt (2.84°)       | 46 pt (0.85°) |
| Natural movement     | 135 pt (2.49°) | 77 pt (1.43°) | 144 pt               | 45 pt         |
| Moving (±5 cm, ±10°) | 152 pt (2.81°) | 94 pt (1.74°) | 140 pt               | 46 pt         |

With low noise, v2 reaches 35–53 pt (0.65–0.99°). With high noise (double jitter) it degrades to 160–197 pt (3–3.7°).
v2 is better than v1 in every simulated condition. The cost is that the smoothed pointer takes about 170 ms to
settle after a jump (v1 takes about 120 ms), and about 360 ms with high noise.

**Selecting things (simulated, dwell 1200 ms, grid of same-size targets, still head)**

| Target | v1                            | v2                     | v2 + picker/magnifier                   |
| ------ | ----------------------------- | ---------------------- | --------------------------------------- |
| 48 pt  | 0 % (never completes a dwell) | 17 % right, 23 % wrong | 72 % right, 3 % wrong                   |
| 96 pt  | 0 %                           | 85 % right, 15 % wrong | **95 % right, 2 % wrong**, median 2.6 s |
| 160 pt | 0 %                           | 98 % right, 0 % wrong  | 98 % right, 2 % wrong                   |

In simulation, v1's pointer shakes more than the dwell's 60 px stability rule allows, so it never selects anything
at these noise levels. In a noise-free run it selects in 1.2 s, so this is the noise, not a harness bug. Whether real
webcam noise is this high is exactly what hasn't been measured (see below). Even with v2, plain dwell on 96 pt
targets picks the wrong one about 15 % of the time; the picker and magnifier are what bring wrong selections near
zero. Small targets (48 pt) still time out about a quarter of the time.

**Other simulated measurements**

- False activations while reading a page completely covered by 96 pt targets: 0 to 0.05 per minute for v2, 0 for
  v1 (over 21.7 simulated minutes per head condition).
- Lifeline's help signal: fires exactly once on three long blinks (uncalibrated, head mode, paused, and during
  calibration), and **never** during 10 simulated minutes of reading with natural blinks or a 3 s rest with eyes
  closed (`tests/engine.test.ts`, `tests/replay.test.ts`, plus the original pattern tests, ported unchanged).
- Head slumping (3 cm down, 6 cm back, 6° over 2 minutes): error grows from about 55 to 98 pt with or without
  continuous recalibration. Continuous recalibration cut wrong selections by about 20 % (108 → 86) but did **not**
  reduce the error, and it did not advise a recalibration in that test. It is conservative by design (it never
  applies an update that doesn't beat the current one on held-out selections), and in simulation it mostly declines.
  It needs real-world tuning.
- Calibration's self-reported error (validation dots) is lower than the error measured afterwards (for example
  44 pt reported vs 69 pt in use, still head). The report is an optimistic estimate; the grade thresholds
  (good ≤ 64 pt, fair ≤ 128 pt, else poor) are applied to it.

**Speed (real measurements, not simulated)**

Apple M5 Pro MacBook, macOS, headless Chrome for Testing 153, WebGL on `ANGLE Metal Renderer: Apple M5 Pro`, the
real MediaPipe Face Landmarker 0.10.35 and this engine, fed by Chromium's fake camera (640×480 at about 31 fps, a
still photo):

|                                      | Frames per second                      | Landmark detection (median) | Camera-to-event latency (median / p95) | Engine time per frame |
| ------------------------------------ | -------------------------------------- | --------------------------- | -------------------------------------- | --------------------- |
| GPU delegate                         | 30.0 (camera-limited)                  | 9.7 ms                      | 13.6 / 28.0 ms                         | < 0.1 ms              |
| CPU delegate                         | 30.0 (17–30 when the machine was busy) | 21.2 ms                     | 24.4 / 28.4 ms                         | < 0.1 ms              |
| GPU, timer scheduler (hidden window) | 30.0                                   | 9.5 ms                      | not reported by this scheduler         | < 0.1 ms              |

Latency is from the camera's reported capture time to the `GazeEvent` in the engine window, measured on the
frames delivered by video-frame callbacks (the timer poll has no capture time). A separate test checks that frames
keep flowing at about 30 fps after the camera preview is removed from the page. It does not include IPC
to the overlay. The engine drops to 15 fps while eye control is paused and 10 fps when nobody is in view, never
lower (the help signal must keep working).

## Context, prediction and the Gaze lab

`src/input/intent.ts` picks the target as P(target | gaze) ∝ exp(-d² / 2σ²) × prior, with σ = error radius / 2 and a
"nothing" hypothesis at the snap distance. Priors are clamped to 0.5–3 and capped at the 96 px hard reach; with
neutral priors (or strength 0) it is exactly the old `findTarget` snap (tested on 2,000 random points). Approval gates
never get more than a neutral prior; protected targets (Stop, Help, Lifeline) always get the highest. The web app's
priors come from `frontend/src/input/context.ts` (planner state and simple rules, computed on the device).

Prediction: when the smoothed pointer makes a fast move (≥ 150 px within 200 ms, ≥ 600 px/s) towards a target with a
prior of at least 1.5 (within 20°), that target is pre-highlighted, and if the eyes land on it its dwell is 0.75× (never
below 0.5×). Never for consequential targets or approval gates. The raw webcam estimate is too noisy to read a direction
from, so it reads the smoothed pointer. Adaptive layout: `PrecisionMeter` averages the error radius (2 s) and reports
sharp (≤ 60 px), normal or rough (≥ 120 px), with 10 px hysteresis and a 3 s hold.

**Measured in simulation** (`npm run bench:intent`, 6 simulated people per head condition, 15 looks each, typical
noise, full-screen grids of 96 and 120 px targets with 24 px gaps; full tables in `bench/results/intent.md`). "Right"
marks the wanted target likely; "wrong" marks a neighbour of it instead (the worst case):

| prior | correct, no context | correct, context right | correct, context wrong | pays off if the context is right at least |
| ----- | ------------------- | ---------------------- | ---------------------- | ----------------------------------------- |
| 1.25  | 85 %                | 98 %                   | 76 %                   | 41 % of the time                          |
| 1.5   | 85 %                | 99 %                   | 65 %                   | 59 % of the time                          |
| 2     | 85 %                | 100 %                  | 48 %                   | 72 % of the time                          |
| 3     | 85 %                | 100 %                  | 31 %                   | 79 % of the time                          |

A wrong context costs more than a right one gains, so the app uses small priors: 1.5 only where the planner is waiting
for exactly that control, 1.25 for guesses (the usual, word predictions). With the context right, selection is also
faster (96 px, still head: median 3.0 s → 2.0 s at prior 1.5). Prediction cut the median a further 0.1–0.25 s with no
extra wrong selections in the selection test, but while reading three pages under a grid with 1 in 8 targets marked
likely it added unwanted selections: 0.38 per minute (still head) and 0.77 (natural) against 0 and 0.46 without it.
The simulated person doesn't react to the highlight, so it never corrects a wrong one; real people do, so the "wrong"
column is pessimistic, but that is not measured.

**The Gaze lab** (Settings › Gaze lab in the web app) is where real numbers come from: a 9-dot test (10 / 50 / 90 %,
2.5 s per dot, the first 800 ms ignored, the pointer hidden) measures accuracy, jitter raw and filtered, settle time,
and the measured error radius (86th percentile of sample errors) against the engine's own estimate. It replays the
person's raw estimates through 27 filter settings (z 2.5 / 3.3 / 4.2, minK 1–3, window 0.6 / 1 / 1.5 s) and ranks them by
jitter plus 0.2 px per ms of extra settle time; it suggests snap = error radius − 48 px (24–96) and steadiness = 3 ×
jitter (30–150). Nothing is applied until the person says so; filter tuning stays on the device. The export is numbers
only (no images, landmarks, samples, positions or time of day). **No real person has been through the lab yet.**

## What was not measured## What was not measured

- **Real people.** No accuracy, precision, selection or false-activation number has been measured with a real
  person, let alone a person with ALS, nystagmus, ptosis, glasses or uneven lighting. The synthetic face has none of
  MediaPipe's real systematic errors, so the simulated accuracy is an upper bound. The noise levels are assumptions.
- A real webcam: the speed test used a fake camera playing a still photo.
- The engine inside the Electron app: `engine.html` builds, and CI's macOS job loads it, but the gaze window has no
  calibration channel yet (`INTEGRATION_REQUEST.md`), so calibration v2 can't be run in the OS today.
- Multiple real displays, external trackers (no hardware), Intel Macs, and battery or thermal impact.
- The magnifier and picker as the overlay will draw them (Instance 3). The benchmark simulates their decisions.

## Commands

```sh
npm run check -w @agency/gaze      # typecheck, format, 126 unit/replay tests (runs in make check)
npm run build -w @agency/gaze      # dist/engine.html for the desktop app (runs in make os-build)
cd os/gaze && npm run bench        # simulated benchmark -> bench/results/pipeline.{json,md} (~70 s)
cd os/gaze && npm run bench:intent # context priors and prediction (simulated) -> bench/results/intent.{json,md} (~20 s)
cd os/gaze && npm run fixtures     # regenerate fixtures/replay/*.json (synthetic, landmarks only)
make e2e-fixtures && cd os/gaze && npm run bench:browser   # real MediaPipe in Chromium -> bench/results/browser-*.json
```

On macOS without Playwright's own Chromium, set `PW_CHROMIUM` to a Chrome for Testing binary.

## Using it

```ts
import { GazeEngine, MouseProvider, singleDisplay } from "@agency/gaze";

const engine = new GazeEngine({ screen: singleDisplay(1470, 956) });
engine.on((event) => console.log(event)); // contract GazeEvents
const mouse = new MouseProvider();
await engine.attach(mouse);
mouse.attachTo(window); // develop the overlay without a camera
```

Fakes for other instances: `MouseProvider`, `ReplayProvider` (with the recordings in `fixtures/replay/`),
`FakeGazeSource`/`fakeGazeEvents` (scripted contract events, including the help pattern), and
`ScriptedTrackerDriver` (external trackers).
