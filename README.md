# AGENCY

**An accessibility-first AI agent that turns a few deliberate selections into completed, verified digital tasks.**

People with severe motor disabilities (advanced ALS, high spinal cord injury, severe cerebral palsy) often keep a
reliable way to signal intent, such as eye movement, but can't drive a keyboard, mouse or touchscreen through
dozens of small steps. AGENCY separates the two: the person expresses an intention through an accessible interface
(eye gaze, a head pointer, a long-blink switch, a key switch, or a mouse), and an agent plans the work, runs it through
explicitly permitted tools, stops for approval before anything consequential, verifies every result against the
service's own records, recovers from failures, and keeps the case so it can be resumed.

**Lifeline** is the part that can save a life. Someone who can't speak or move can't reach a phone or press a
pendant when their ventilator mask slips at 3 a.m. With Lifeline they close their eyes for a second, three times
(or look at Help), and AGENCY keeps contacting people, one after another, until a human answers "I'm on my way". It
also raises the alarm on its own when the person's computer goes silent or a check-in goes unanswered. The
coordinator, ideally a Raspberry Pi separate from the laptop, owns every alert, so help keeps being called even if
the laptop dies. See [LIFELINE.md](LIFELINE.md) for the design and safety case.

Built for the UCSC AI Hackathon (Cloud AI track). Hardware: a MacBook (webcam, browser, interface) and an optional
Raspberry Pi 4 (coordinator, SQLite). Cloud reasoning with Google Gemini is optional; everything works without it.

> AGENCY is a demonstration, not a medical device, a ventilator alarm or an emergency service. Webcam gaze
> estimation is approximate. All integrations are simulated demo services, and Lifeline contacts are simulated
> phones: no real company, office or person is contacted unless someone deliberately configures real phone numbers
> and Twilio.

---

## AGENCY OS (the desktop app)

AGENCY is growing into **AGENCY OS**: a Mac app that runs full screen as the person's home, floats eye control over
every app, lets an agent do real tasks with their approval, and keeps Lifeline one look away. The plan, ownership
and safety rules are in [docs/os/PLAN.md](docs/os/PLAN.md); what works today is in
[docs/os/STATUS.md](docs/os/STATUS.md); installing a release is in [docs/os/INSTALL.md](docs/os/INSTALL.md).

```bash
make setup      # once
make os-dev     # run the desktop app from source (windowed)
make os-test    # type-checks, unit tests and Electron smoke tests (macOS)
make os-dist    # a .dmg (unsigned unless signing secrets are set)
```

The repository is an npm workspace (`frontend`, `os/*`, `site`); `make check` covers the web app and the OS packages.
The web demo below works exactly as before.

## Quick start (MacBook)

Requires Python 3.11+ (`brew install python@3.12`, or `uv`) and Node 20.19+ (`brew install node`).

```sh
git clone https://github.com/NeilGilani/game.git ~/agency
cd ~/agency
make setup
make demo
```

Open **http://localhost:8000** in Chrome. (The camera needs `localhost` or https.)

For the hackathon, open **http://localhost:8000/#/demo** or choose **Live demo** in the navigation.
This presenter view follows real cases, approvals, recovery steps, and verification records from the running
coordinator. Its counters start at zero; they are measured from SQLite, not sample statistics. Choose
**Get moving again** to start the flagship repair workflow. The cloud panel reports the actual reasoning mode,
and each case identifies whether its plan was adapted by Claude or uses the built-in fallback.

Every case now offers **Download evidence**: a JSON receipt with the case, all recorded step statuses,
approvals, tool calls, and verification checks, including unfinished work and the simulated-service disclosure.

For development with live reload (interface on http://localhost:5173, coordinator on :8000):

```sh
cd ~/agency
make dev
```

How Lifeline works and why it's designed this way: see [LIFELINE.md](LIFELINE.md). Using a Raspberry Pi as the
coordinator: see [DEPLOY_PI.md](DEPLOY_PI.md). Running the 5-minute demo:
see [DEMO_SCRIPT.md](DEMO_SCRIPT.md). How it's built: see [ARCHITECTURE.md](ARCHITECTURE.md).

To enable cloud reasoning, put a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) in `.env`
as `GEMINI_API_KEY=...` (copy `.env.example`; the default model is `gemini-3.8-flash`). The status bar then shows
**Gemini · gemini-3.8-flash**. Without a key it says **Demo mode: built-in plans**. An Anthropic key
(`ANTHROPIC_API_KEY`) still works as an alternative; when both are set, Gemini is used unless
`AGENCY_REASONING=anthropic`. The key stays on the coordinator and is never sent to the browser.

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
  Built-in plans for four goals; optional Gemini-adapted plans that must pass the same validator.
- A tool registry over four simulated services (Demo Repair Provider, Demo Funding Service, Demo Calendar, Demo
  Messaging Service), each with its own tables and HTTP endpoints. No shell, SQL, browser or arbitrary HTTP tools.
- Approvals bound to a fingerprint of the exact inputs; changing anything requires a fresh approval.
- Idempotency keys per step, bounded retries with backoff, timeouts, reconciliation of uncertain outcomes with the
  service before retrying, separate "succeeded" (tool said so) and "verified" (service records agree) states,
  recovery planning (e.g. a taken slot leads to "find another time, ask before booking"), and restart recovery that
  holds interrupted cases until the person presses Resume.
- Global **Stop agent**, per-case pause/resume/cancel, skipping optional steps, editing approvals, "Explain".
- A full audit trail: events, tool calls (with idempotency keys and timings) and verification checks.

**Lifeline: calling for help** ([LIFELINE.md](LIFELINE.md))
- Three ways to ask: **three long blinks** (watched whenever the camera is on, in every input mode, even with eye
  control paused; ordinary blinks, resting and face loss are ignored), a **Help** button that is first in scanning
  order on every screen, or a helper's click. An 8-second countdown with a hard-to-hit-by-accident Cancel.
- The coordinator owns the alert: it alerts contacts in order, moves on after 45 s without an answer (or at once if a
  message fails or someone can't come), then alerts everyone again, every 90 s, until someone presses **I'm on my
  way**. Others are told to stand down; ending the alert sends everyone an all-clear.
- Contacts answer from a plain web page reached by a personal link (no app, no login). While the alert is open it
  shows the person's **responder card**: how they communicate, breathing equipment to check first, allergies,
  medications, how to get in.
- **Watch over me**: alerts on its own if the person's screen goes silent for 30 s (heartbeats from a Web Worker),
  if a check-in goes unanswered, or (optionally) if the eyes can't be seen for minutes.
- If the coordinator can't be reached, the laptop sounds a loud alarm at once and keeps retrying (the request
  survives a reload). Alerts survive a coordinator restart.
- Readiness checklist, monthly test alerts, response-time report, presenter fault injection, simulated phones in
  their own window (with QR codes so a real phone can answer when the coordinator is on the network), and optional
  real SMS and voice calls through Twilio.

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

The table below preserves validation of the original implementation, including its separate hardware and
environment checks. Run `make check` and `make e2e` to validate the current checkout. New regression coverage
checks live demo metrics against actual records, cloud request budgets, evidence downloads, keyboard focus in
approval dialogs, retrying an unavailable interpreter, stale responses after case selection, and mobile layouts.

The experience upgrade was validated on macOS arm64 with Node 22 and Python 3.14: **117 backend tests,
62 frontend tests, 31 desktop unit tests, and 18 browser tests passed**. `make check` passed formatting,
linting, strict type checks, and the production build. Browser tests included the real MediaPipe pipeline with
the fake-camera fixture. No live cloud API call was made; an Anthropic key was not configured.

| Suite | Count | What it covers |
|---|---|---|
| Backend `pytest` | 132 | **Workflow engine (45):** case creation, plan contents, allowed and refused tools, input validation, approval creation, refusing unapproved or stale-approved actions, verification pass/fail, retries, idempotent services, timeout reconciliation (no double booking), recovery planning, rejection blocking dependents, edits rebinding approvals, global and per-case pause, crash mid-step + restart reconciliation, persistence across restarts, audit events, auth token, CORS, preferences validation, the other three goals, and the Claude provider with a fake client. **Lifeline (38), on a fake clock:** countdown, cancel, call now, escalation timing and repeating rounds, immediate fail-over, never giving up, acknowledgement and stand-down, withdrawn acknowledgement, all-clear, consent and alarm-only mode, the responder page (escaping, security headers, token uniqueness, confirmation), watchdog, check-ins (including turning Watch over me off), signal-unavailable, restart persistence, reporting, demo reset, and Twilio text + call with a fake transport. **Rescue (29):** what's wrong and urgency (critical alerts reach everyone at once), helpers' yes/no questions answered with the eyes, care-plan steps, arrival, simulated dispatch with its own consent, the demo smart home and power watch, and the handoff summary. **Gemini (20):** the real google-genai SDK against a fake HTTP transport: endpoint, key in a header and never in the URL, structured-output schema and thinking level, a valid plan used and a plan with a forbidden tool rejected, each error class falling back to built-in plans and reported, blocked, truncated and non-JSON responses, the credential check, provider selection, and the key never returned by the API |
| Frontend Vitest | 56 | Landmark indices checked against the installed MediaPipe package; feature extraction on synthetic landmark fixtures; head pose; calibration fitting, outlier rejection and honest quality grading; dwell stability, no repeat, refractory, blink tolerance and tracking-loss cancel; scanning; long-blink switch; camera error classification; target snapping; smoothing; **the three-long-blink help signal** (ordinary blinks, resting, face loss, spacing, refractory, hysteresis) |
| Playwright e2e | 14 | The full repair scenario in a real browser (plan, approvals, injected slot failure, recovery, browser refresh, verified outcome, timeline, service records); editing and declining; coordinator loss and restart; Stop agent; key-switch scanning; dwell selection through the real DOM with synthetic gaze frames; the **real camera pipeline** with a fake webcam; camera permission denied. **Lifeline:** cancel in the countdown; caregiver unreachable, fail-over, the neighbour answering on the real response page in another window, ending the alert; three long blinks (synthetic blink frames) vs ordinary blinks; check-in and watchdog; offline queueing across a reload and recovery |
| Python 3.11 / arm64 | 132 / 83 | The backend suite on Python 3.11 (132, this commit); on an earlier commit (83 tests), the suite on Debian Bookworm arm64 (emulated with QEMU), plus `deploy/pi/setup.sh` end to end in that container, including a Lifeline alert, a response through the response page, and a watchdog alert from the supervisor loop |

What was **not** tested here, and why: live gaze accuracy and the blink help signal with real people (needs people
in front of a webcam, ideally the target users; the automated camera test uses a still image), real Raspberry Pi
hardware (no Pi in this environment; tested on emulated arm64 Debian Bookworm), Safari, a successful call to the real Gemini
or Anthropic API (no API key in this environment; the Gemini adapter is tested through the real google-genai SDK
against a fake HTTP transport, and a live request with a deliberately invalid key was correctly reported as "the API
key was rejected"; the Anthropic adapter is tested with a fake client that mirrors the SDK's response shapes), real
Twilio messages and calls (no account; tested with a fake transport), and heartbeats from a tab hidden for hours.
The simulated phones' QR codes were checked by decoding a rendered code with an independent decoder.

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
- Lifeline shares the person's name, what happened and their responder card only with their own contacts, only
  through per-message unguessable links, and only while the alert is open. Permission to contact people without
  asking is given once in setup and recorded with its time; without it Lifeline only sounds the local alarm.
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
- Lifeline is not a medical alarm and isn't connected to any medical device. Its blink thresholds are reasoned
  defaults that need evaluation with people with ALS or locked-in syndrome. Sound needs one real click or key press
  per page load (a browser rule). A Pi coordinator needs its own UPS to survive a power cut. See
  [LIFELINE.md](LIFELINE.md) for the full list.
- Single user per coordinator; no accounts.
- The coordinator token is a shared secret over plain HTTP on the local network. Fine for a home LAN demo; use TLS
  (e.g. a reverse proxy) for anything beyond that.

## Next highest-value engineering task

**A study with the target users and their caregivers**, covering both how reliably they can select with a laptop
webcam (calibration grades, accidental selections, time to select, fallbacks triggered) and how reliably they can
call for help: blink-signal success and false-trigger rates when tired and at night, and Lifeline drills measuring
time to "I'm on my way". The engine and the escalation logic are solid; the open risks are human, and that data
should drive dwell defaults, target sizes and the help-signal thresholds.

---

## Layout

```
backend/            FastAPI coordinator (Python 3.11+)
  agency/engine/    workflow engine, runner, persistence
  agency/planning/  goal interpretation, built-in plans, plan validator
  agency/tools/     permitted tool registry
  agency/services/  simulated integrations + seed data
  agency/reasoning/ optional cloud model (Gemini, or Claude)
  agency/lifeline/  emergency alerts: escalation, watchdog, check-ins, channels, response page
  tests/            pytest suite
frontend/           React + TypeScript + Vite interface
  src/vision/       camera, landmarks, calibration, blink, quality, live tracker
  src/input/        dwell and scan engines, input layer
  src/lifeline/     blink help signal, alarm, heartbeat worker, emergency screen
  src/screens/      every screen
  tests/            Vitest unit tests
  e2e/              Playwright tests
deploy/pi/          Raspberry Pi setup script and systemd unit
```

Third-party licenses: [THIRD_PARTY.md](THIRD_PARTY.md).
