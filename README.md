# AGENCY

**An accessibility-first AI agent that turns a few deliberate selections into completed, verified digital tasks.**

People with severe motor disabilities (advanced ALS, high spinal cord injury, severe cerebral palsy) often keep a
reliable way to signal intent, such as eye movement, but can't drive a keyboard, mouse or touchscreen through
dozens of small steps. AGENCY separates the two: the person expresses an intention through an accessible interface
(eye gaze, a head pointer, a long-blink switch, a key switch, or a mouse), and an agent plans the work, runs it through
explicitly permitted tools, stops for approval before anything consequential, verifies every result against the
service's own records, recovers from failures, and keeps the case so it can be resumed.

Built for the UCSC AI Hackathon (Cloud AI track). Hardware: a MacBook (webcam, browser, interface) and an optional
Raspberry Pi 4 (coordinator, SQLite). Cloud reasoning with Claude is optional; everything works without it.

> AGENCY is a demonstration, not a medical device. Webcam gaze estimation is approximate. All integrations are
> simulated demo services: no real company, office or person is ever contacted.

---

## Quick start (MacBook)

Requires Python 3.11+ (`brew install python@3.12`, or `uv`) and Node 20.19+ (`brew install node`).

```sh
git clone https://github.com/NeilGilani/game.git ~/agency
cd ~/agency
make setup
make demo
```

Open **http://localhost:8000** in Chrome. (The camera needs `localhost` or https.)

For development with live reload (interface on http://localhost:5173, coordinator on :8000):

```sh
cd ~/agency
make dev
```

Using a Raspberry Pi as the coordinator: see [DEPLOY_PI.md](DEPLOY_PI.md). Running the 5-minute demo:
see [DEMO_SCRIPT.md](DEMO_SCRIPT.md). How it's built: see [ARCHITECTURE.md](ARCHITECTURE.md).

To enable cloud reasoning, put an Anthropic API key in `.env` (copy `.env.example`). A Claude Max chat subscription
does not include API access. Without a key the status bar says **Demo mode: built-in plans**.

---

## What works

**Accessible input, computer vision in the browser**
- Live webcam pipeline with MediaPipe Face Landmarker (478 landmarks incl. irises), running locally on the MacBook.
  Frames are never stored or uploaded. GPU delegate with automatic CPU fallback.
- Camera setup with a live preview, landmark overlay, and checks for face, eyes/irises, lighting and distance,
  with plain-language guidance. Handles permission denied, no camera, camera busy, insecure page, model failure and
  a stream that drops mid-session.
- Guided 9-point calibration (starts on its own after a countdown, so it needs no click). It fits a ridge regression
  from iris position + head pose to screen position, chooses linear vs quadratic by cross-validation, and reports
  accuracy measured on targets it didn't train on (good / fair / poor). Poor calibration is reported as poor, and a
  fallback is offered. Calibration is kept for the session unless the person chooses "remember on this device".
- Five input modes, all able to drive every screen:
  **eye gaze + dwell**, **head pointer + dwell**, **scanning with a long-blink switch** (camera),
  **scanning with a key switch**, and **mouse/keyboard/touch** (always available to the person or a helper).
- Dwell selection with a configurable time, steadiness requirement, target snapping, pause-not-reset during blinks,
  no repeat while the gaze stays on a selected button, a refractory period after every selection or screen change,
  and a protected "Resume eye control" target. Consequential actions always need a second confirmation placed
  elsewhere on screen.
- Tracking loss is visible; after 10 s it switches to key scanning automatically and switches back when tracking
  returns.

**Agent and workflow engine (coordinator)**
- Structured, validated goals from goal cards, a phrase board, or typed text (cloud interpretation when configured).
- Dependency-aware plans with typed tool calls, approval levels, verification descriptions and retry policies.
  Built-in plans for four goals; optional Claude-adapted plans that must pass the same validator.
- A tool registry over four simulated services (Demo Repair Provider, Demo Funding Service, Demo Calendar, Demo
  Messaging Service), each with its own tables and HTTP endpoints. No shell, SQL, browser or arbitrary HTTP tools.
- Approvals bound to a fingerprint of the exact inputs; changing anything requires a fresh approval.
- Idempotency keys per step, bounded retries with backoff, timeouts, reconciliation of uncertain outcomes with the
  service before retrying, separate "succeeded" (tool said so) and "verified" (service records agree) states,
  recovery planning (e.g. a taken slot leads to "find another time, ask before booking"), and restart recovery that
  holds interrupted cases until the person presses Resume.
- Global **Stop agent**, per-case pause/resume/cancel, skipping optional steps, editing approvals, "Explain".
- A full audit trail: events, tool calls (with idempotency keys and timings) and verification checks.

**Flagship scenario:** arrange a wheelchair repair before Friday, check whether funding help may be available
(without ever claiming coverage), and notify the caregiver, including a deliberate failure and recovery.
Three more goals work end to end: reschedule an appointment (asks which one mid-workflow), prepare/submit/track an
administrative form, and send a message with a follow-up reminder. "Resume a case" lists saved cases.

---

## Commands

| Command | What it does |
|---|---|
| `make setup` | Create `backend/.venv` (Python 3.11+), install backend and frontend dependencies |
| `make demo` | Build the interface and serve everything from the coordinator at http://localhost:8000 |
| `make dev` | Coordinator with reload on :8000 and Vite on :5173 |
| `make dev-pi PI=agency-pi.local` | Interface on the Mac, coordinator on the Pi |
| `make check` | Ruff, ruff-format, mypy --strict, ESLint, Prettier, tsc, all unit tests, production build |
| `make test` | Backend (pytest) and frontend (Vitest) unit tests |
| `make e2e` | Playwright browser tests against a real coordinator (first time on a Mac: `cd ~/agency/frontend && npx playwright install chromium`) |
| `make reset-demo` | Reset demo data on a running coordinator |
| `make pi-setup` / `pi-status` / `pi-logs` | Raspberry Pi service management (run on the Pi) |

---

## Testing

All of the following were run for this commit; results are from real runs, not estimates.

| Suite | Count | What it covers |
|---|---|---|
| Backend `pytest` | 45 | Case creation, plan contents, allowed and refused tools, input validation, approval creation, refusing unapproved or stale-approved actions, verification pass/fail, retries, idempotent services, timeout reconciliation (no double booking), recovery planning, rejection blocking dependents, edits rebinding approvals, global and per-case pause, crash mid-step + restart reconciliation, persistence across restarts, audit events, auth token, CORS, preferences validation, the other three goals, and the cloud provider with a fake client (valid plan used; plan with a forbidden tool rejected; API errors and refusals fall back and are reported) |
| Frontend Vitest | 46 | Landmark indices checked against the installed MediaPipe package; feature extraction on synthetic landmark fixtures; head pose; calibration fitting, outlier rejection and honest quality grading; dwell stability, no repeat, refractory, blink tolerance and tracking-loss cancel; scanning; long-blink switch; camera error classification; target snapping; smoothing |
| Playwright e2e | 9 | The full repair scenario in a real browser (plan, approvals, injected slot failure, recovery, browser refresh, verified outcome, timeline, service records); editing and declining; coordinator loss and restart; Stop agent; key-switch scanning; dwell selection through the real DOM with synthetic gaze frames; the **real camera pipeline** with a fake webcam (face and irises found; calibration on a still photo correctly graded "poor"); camera permission denied |
| Python 3.11 / arm64 | 45 | The backend suite on Python 3.11, and on Debian Bookworm arm64 (emulated with QEMU), plus `deploy/pi/setup.sh` end to end in that container |

What was **not** tested here, and why: live gaze accuracy with a real person (needs a human in front of a webcam;
the automated camera test uses a still image), real Raspberry Pi hardware (no Pi in this environment; tested on
emulated arm64 Debian Bookworm), Safari, and the real Anthropic API (no API key in this environment; the adapter is
tested with a fake client that mirrors the SDK's response shapes).

```sh
cd ~/agency
make check
make e2e
```

---

## Privacy and safety

- Camera frames are processed in the browser and discarded. No video, images, landmarks or calibration data are sent
  to the coordinator or the cloud. Calibration is a handful of numbers kept for the session unless the person opts in.
- When cloud reasoning is configured, only goal text, selections, the fictional demo profile summary, the tool catalog
  and the built-in plan are sent. Model output is validated; it never executes anything and never decides whether an
  action happened.
- Every consequential action needs an explicit approval (and a confirmation in hands-free modes). Drafts and submitted
  actions, and proposed and verified outcomes, are always shown differently.
- The coordinator refuses to listen on the network without an access token. Secrets live only in environment
  variables and never appear in the interface bundle or API responses.
- All demo data is fictional ("Riley", "Jordan", demo providers).

---

## Known limitations

- Webcam gaze is approximate (typically several degrees). AGENCY compensates with large, well-spaced targets, snapping,
  steadiness checks and a measured accuracy grade, but small targets and fast use aren't realistic. Head-pose changes
  after calibration reduce accuracy; recalibrate if the person moves.
- Head-pointer and blink-switch modes are implemented and unit-tested but haven't been evaluated with real users.
- Integrations are simulated. Real providers would need authentication, per-integration permissions and their own
  verification rules (the adapter boundary is designed for this).
- Cloud planning adapts the built-in plans; it doesn't invent new workflow types.
- Single user per coordinator; no accounts.
- The coordinator token is a shared secret over plain HTTP on the local network. Fine for a home LAN demo; use TLS
  (e.g. a reverse proxy) for anything beyond that.

## Next highest-value engineering task

**A live usability and accuracy study of the gaze and blink modes with the target users**, instrumented with the
existing calibration quality numbers and dwell events (accidental selections, time-to-select, fallbacks triggered).
The workflow engine is solid; the biggest open risk is how reliably real users can select with a laptop webcam, and
that data should drive dwell defaults, target sizes and whether to add a per-session drift correction.

---

## Layout

```
backend/            FastAPI coordinator (Python 3.11+)
  agency/engine/    workflow engine, runner, persistence
  agency/planning/  goal interpretation, built-in plans, plan validator
  agency/tools/     permitted tool registry
  agency/services/  simulated integrations + seed data
  agency/reasoning/ optional Anthropic provider
  tests/            pytest suite
frontend/           React + TypeScript + Vite interface
  src/vision/       camera, landmarks, calibration, blink, quality, live tracker
  src/input/        dwell and scan engines, input layer
  src/screens/      every screen
  tests/            Vitest unit tests
  e2e/              Playwright tests
deploy/pi/          Raspberry Pi setup script and systemd unit
```

Third-party licenses: [THIRD_PARTY.md](THIRD_PARTY.md).
