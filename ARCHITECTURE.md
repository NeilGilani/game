# AGENCY architecture

## Shape of the system

```
 MacBook                                              MacBook or Raspberry Pi 4
 ┌──────────────────────────────────────────────┐     ┌────────────────────────────────────────────────┐
 │ Browser (http://localhost: secure context)   │     │ Coordinator (FastAPI, Python 3.11+)            │
 │                                              │     │                                                │
 │ webcam ─▶ MediaPipe Face Landmarker (WASM)   │     │  /api  ─▶ Planner ─▶ Plan validator             │
 │          ─▶ features (iris, head pose, blink)│     │            │  (built-in plans; optional Gemini) │
 │          ─▶ calibration ─▶ smoothed pointer  │HTTP │            ▼                                    │
 │          ─▶ dwell / scan engines             │────▶│        Engine: approvals, idempotent execution, │
 │          ─▶ click() on large targets         │JSON │        retries, timeouts, verification,        │
 │                                              │     │        recovery, restart reconciliation        │
 │ Screens render coordinator state only        │◀────│            │                                    │
 └──────────────────────────────────────────────┘     │            ▼                                    │
                                                      │  Tool registry (typed, permitted tools only)    │
   nothing about the face or video leaves             │            │                                    │
   the browser                                        │            ▼                                    │
                                                      │  Demo services (own tables + HTTP endpoints):   │
                                                      │  Repair Provider · Funding · Calendar · Messaging│
                                                      │            │                                    │
                                                      │        SQLite (WAL, versioned migrations)       │
                                                      └────────────────────────────────────────────────┘
                                                                   │ optional, server-side only
                                                                   ▼
                                                        Gemini API (or Claude): interpret goals,
                                                        adapt plans, explain, all validated
```

The camera page must be served from `localhost` (or https), because browsers only allow `getUserMedia` in a secure
context. So the interface always runs on the MacBook. When the coordinator runs on the Pi, Vite on the Mac forwards
`/api` to it (`make dev-pi`), or the interface calls it directly (address + token in Settings; CORS allow-list on the
Pi).

## Module boundaries

| Module | Responsibility | Must not |
|---|---|---|
| `frontend/src/vision` | Camera access, MediaPipe, feature extraction, calibration, blink detection, quality, smoothing | Touch application state or the network |
| `frontend/src/input` | Dwell and scan engines (pure), the input layer that turns selections into `click()` | Know what a button does |
| `frontend/src/screens`, `components`, `state` | Presentation; poll the coordinator; send decisions | Decide whether an action succeeded |
| `backend/agency/planning` | Goal interpretation, built-in plans, plan validation, reference syntax | Execute anything |
| `backend/agency/reasoning` | Optional cloud model (Gemini, or Claude) with structured outputs; deterministic fallback | Bypass the validator or executor |
| `backend/agency/engine` | State machines, execution, approvals, verification, recovery, persistence, runner | Call services except through tools |
| `backend/agency/tools` | The permitted-tool registry: typed inputs, run, verify, lookup, describe, edit | Expose shell, SQL, browser or arbitrary HTTP |
| `backend/agency/services` | Simulated integrations with their own tables and endpoints | Be reached by the engine except via tools |
| `backend/agency/lifeline` | Emergency alerts: lifecycle, escalation, watchdog, check-ins, channels, the responder page | Depend on the person's screen staying alive |
| `frontend/src/lifeline` | Blink help signal (pure), alarm sounds, heartbeat worker, offline help queue, emergency screen | Decide whether help is coming |

The vision module never writes application state; the language model never reaches the executor except through a
validated plan; the interface never decides outcomes. The single source of truth for workflow state is the
coordinator's SQLite database (`engine/store.py`).

## Data models

Pydantic models (`backend/agency/models.py`) and mirrored TypeScript types (`frontend/src/api/types.ts`):

- **Goal**: goal type, plain-language outcome, deadline, preferences, entities, constraints, missing information,
  actions needing approval, prohibited operations, options. Validated (`extra="forbid"`, bounded strings, ISO dates).
- **PlanDraft / StepDraft**: id, title, description, tool, inputs (literals or references to earlier outputs),
  dependencies, preconditions, approval level, optional flag, expected output, verification description, retry
  policy, timeout, question (for steps that ask the person).
- **Step** (persisted): the above plus status, attempts, output, error, evidence, idempotency key, recovery links.
- **ToolInvocation**: tool, resolved inputs, idempotency key, attempt, status (`started`, `succeeded`, `failed`,
  `timeout`, `interrupted`, `reconciled`, `error`), result, duration.
- **ToolResult** / **ToolError**: structured success or failure with `retryable`.
- **ApprovalRequest**: plain-language summary and details, the inputs fingerprint it is bound to, status.
- **VerificationResult**: named checks with expected/observed values.
- **AuditEvent**: actor (you, AGENCY, system, presenter), kind, plain-language message, minimal data.
- **Preferences** (accessibility; no biometrics), **CalibrationModel** (browser only), **IntegrationInfo**,
  **FaultConfig** (presenter-only).

Schema evolution: forward-only numbered migrations in `db.py`, recorded in `schema_migrations`.

## Step state machine

```
pending ──▶ waiting_input ──▶ verified
   │
   ├──▶ awaiting_approval ──▶ approved ──▶ running ──▶ succeeded ──▶ verified
   │          │                              │  ▲          │
   │          └──▶ rejected                  │  └ retrying │
   │                                         ├──▶ failed ◀─┘ (verification failed)
   │                                         └──▶ approved/pending (restart: never reached the service)
   └──▶ blocked / skipped / cancelled
failed / rejected ──▶ superseded (replaced by a recovery step)
```

Transitions are enforced (`check_transition`); for example a step cannot go from `pending` to `verified`, or from
`awaiting_approval` to `running`. "Planned", "attempted" (an invocation exists), "succeeded" (the tool said so) and
"verified" (the service's records agree) are distinct and visible in the interface.

Case status is derived after every pass: waiting for input, waiting for approval, completed (everything verified or
recovered), completed with open items, paused, interrupted (after a restart), needs attention, cancelled.

## Execution guarantees (engine/engine.py)

1. **Permitted tools only.** The step's tool must exist and be allowed for the goal type; otherwise it is refused and
   audited (`action_refused`).
2. **Inputs from verified results.** References (`{"$ref": "find_slots.recommended.slot_id"}`) resolve only against
   outputs of verified steps; the resolved inputs are validated against the tool's typed model.
3. **Approval bound to exact inputs.** A consequential tool runs only if the latest approval is `approved` and its
   fingerprint matches the canonical JSON of the inputs about to run. Edits create a new approval; stale approvals are
   rejected and audited.
4. **Never repeat success.** Each step has one idempotency key used for every attempt. Before running, the engine
   checks for a prior successful invocation; after a timeout or interruption it asks the service (`lookup`) whether the
   action went through before retrying. Demo services deduplicate by key.
5. **Bounded retries** for retryable errors only (e.g. 503), with backoff; business errors (slot taken) go straight to
   recovery.
6. **Verification** re-reads the service's records (booking confirmed at the approved slot; inquiry received with no
   decision; message delivered with the approved text's digest).
7. **Recovery** inserts new steps (e.g. find another time, then book it with approval), rewires dependents, bumps the
   plan version and explains what happened and what was checked. At most two recovery generations per step.
8. **Pause** (global or per case) stops before the next step; in-flight calls finish and are recorded.
9. **Restart reconciliation** marks open invocations interrupted, asks services what happened, settles steps, and holds
   the case as `interrupted` until the person presses Resume.

## Planning and cloud reasoning

`planning/templates.py` holds the built-in plans. `planning/validate.py` checks any plan: unique ids, dependencies only
on earlier steps, tools exist and are permitted, references only to dependencies and to keys the source tool actually
produces, literal inputs type-check, consequential tools forced to `approval: required`, finalizers appended.

When a cloud model is configured (`reasoning/provider.py`): Google Gemini when `GEMINI_API_KEY` is set, otherwise
Claude when `ANTHROPIC_API_KEY` is set (`AGENCY_REASONING=gemini|anthropic|deterministic` forces one):

- `interpret_goal`: free text or phrases → a JSON-schema-constrained set of fields; the Goal is still built by the
  deterministic code from those fields.
- `draft_plan`: the model receives the goal, the tool catalog (with JSON schemas) and the built-in plan, and returns a
  plan via structured outputs. If it fails validation, AGENCY uses the built-in plan and says why.
- `explain`: plain-language explanation of an approval, labelled with the model that wrote it, next to AGENCY's own facts.

Both providers share the prompts, schemas and parsing (`CloudProvider`); each implements one structured-output call
and a credential check:

- **Gemini** (default model `gemini-3.8-flash`, `AGENCY_GEMINI_MODEL`): the official `google-genai` SDK,
  `client.aio.models.generate_content` with `response_mime_type="application/json"` and `response_json_schema`, the
  system prompt as `system_instruction`, and `thinking_level` from `AGENCY_REASONING_EFFORT` (Gemini 3 models only).
  The key goes in the `x-goog-api-key` header. Blocked prompts, safety stops and truncation are treated as failures.
- **Claude** (default `claude-opus-5-5`, `AGENCY_ANTHROPIC_MODEL`): `client.beta.messages.create` with
  `output_config.format` (JSON schema), effort, prompt caching, and server-side refusal fallback.

Errors are caught by type (key rejected, permission, model not found, rate limit, bad request, service error,
network) and recorded in the provider status shown on the Status screen; AGENCY then uses its built-in plans.

## Computer vision pipeline (frontend/src/vision)

- **tracker.ts**: `getUserMedia` (640×480 user-facing) → `FaceLandmarker.detectForVideo` (VIDEO mode, one face,
  blendshapes and transformation matrix enabled) every animation frame; GPU delegate with CPU fallback; brightness
  sampled once a second from a 32×24 canvas.
- **landmarks.ts**: for each eye, the iris centre (mean of the 4 iris ring points) is projected onto the
  corner-to-corner axis (`h`, 0..1) and its normal (`v`, in eye widths); lid opening gives openness. Head pose comes
  from the 4×4 facial transformation matrix. Indices are verified against the package's connection tables in tests.
- **calibration.ts**: features `[h, v, yaw, pitch]` (gaze) or `[yaw, pitch, nose x, nose y]` (head pointer);
  per-target median/MAD outlier rejection; standardisation; ridge regression per axis; linear vs quadratic chosen by
  leave-one-target-out error, which is also the reported accuracy.
- **oneEuro.ts**: One Euro filter on the pointer; steadiness preference maps to its cut-off.
- **blink.ts**: blendshape `eyeBlink` score (or openness with an adaptive baseline) → a press after a held closure,
  once per closure, never on face loss.
- **quality.ts**: face distance, centring, head turn, lighting, and a per-frame confidence that gates dwell.

Input engines (`frontend/src/input`) are pure and unit-tested; `InputLayer.tsx` collects visible `[data-dwell]`
targets (limited to an open dialog), snaps the pointer to the nearest target within a radius, feeds the dwell or scan
engine, draws feedback through attributes (no re-render per frame), and calls `click()`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Public liveness: node (MacBook or Pi), database, reasoning mode, auth required |
| GET | `/api/runtime` | Full runtime status, integrations, privacy statement |
| POST | `/api/runtime/check-cloud` | Credential check against the Models API (no tokens generated) |
| GET | `/api/goals/catalog` | Goal cards, phrases, suggestions |
| POST | `/api/goals/interpret` | Selections/phrases/text → validated Goal + questions |
| POST/GET | `/api/cases`, `/api/cases/{id}` | Create (plans and starts) / read a case with steps, approvals, next actions |
| GET | `/api/cases/{id}/timeline` | Audit events, tool invocations, verifications, approvals |
| POST | `/api/cases/{id}/pause` · `resume` · `cancel` | Case control |
| POST | `/api/cases/{id}/steps/{step}/answer` · `skip` | Answer a question; skip an optional step |
| GET/POST | `/api/approvals`, `/api/approvals/{id}/decision`, `/api/approvals/batch`, `/api/approvals/{id}/edit`, `/api/approvals/{id}/explain` | Approvals |
| POST | `/api/system/pause` · `resume` | Stop / resume all automation |
| GET/PUT | `/api/preferences` | Accessibility preferences |
| GET | `/api/activity` | Recent verified outcomes and notable events |
| GET/PUT, POST | `/api/demo/faults`, `/api/demo/reset` | Presenter controls (disable with `AGENCY_DEMO_CONTROLS=0`) |
| GET | `/api/demo-services/...` | Each demo service's own records (slots, requests, programs, cases, events, outbox) |
| GET | `/api/lifeline/status` | Settings, readiness problems, Watch over me state, the open alert, recent alerts |
| GET/PUT | `/api/lifeline/settings` | Contacts, consent (time recorded by the coordinator), timings, responder card |
| POST | `/api/lifeline/help` | Start an alert (`source`, `test`); never opens a second one |
| GET | `/api/lifeline/alerts`, `/api/lifeline/alerts/{id}` | History; one alert with messages, events and timings |
| POST | `/api/lifeline/alerts/{id}/cancel` · `now` · `resolve` | Cancel in the countdown; skip the countdown; end with an all-clear |
| POST | `/api/lifeline/heartbeat` · `monitoring` · `checkin` | Screen alive; Watch over me on/off; answer a check-in |
| GET | `/api/lifeline/outbox`, `/api/lifeline/report` | Simulated phones; response-time report |
| POST | `/api/lifeline/demo/checkin-now` | Presenter: ask for a check-in now |
| GET, POST | `/respond/{token}`, `/respond/{token}/ack` · `decline` · `resolve` | The contact's response page (outside `/api`; the token is the credential) |

When `AGENCY_API_TOKEN` is set, every `/api` route except `/api/health` requires `X-Agency-Token`.

## Lifeline (backend/agency/lifeline, frontend/src/lifeline)

Emergency alerting, documented as a safety case in [LIFELINE.md](LIFELINE.md).

```
 person's screen (MacBook)                          coordinator (ideally the Pi)                    contacts' phones
 ┌────────────────────────────────┐                 ┌──────────────────────────────────────┐       ┌──────────────────┐
 │ HelpPattern (3 long blinks) ─┐ │  POST /help     │ LifelineService                      │ SMS / │ /respond/{token} │
 │ Help button / switch ────────┼─┼───────────────▶ │  alerts: pending ▸ active ▸          │ call /│ plain HTML page: │
 │ offline queue (localStorage)─┘ │                 │          acknowledged ▸ resolved     │ demo  │ on my way /      │
 │                                │  heartbeat 5 s  │  supervisor tick (1 s): countdowns,  │──────▶│ can't come /     │
 │ heartbeat Web Worker ──────────┼───────────────▶ │  escalation, watchdog, check-ins     │       │ safe, end alert  │
 │                                │                 │  SQLite: lifeline_alerts,            │◀──────│ (token = only    │
 │ emergency screen + Web Audio ◀─┼─ GET /status ── │  _notifications, _events             │ POST  │  credential)     │
 │ alarm (siren / countdown)      │                 │  ChannelRouter: Demo | Twilio        │       └──────────────────┘
 └────────────────────────────────┘                 └──────────────────────────────────────┘
```

- **Ownership.** The coordinator owns every alert and every timer. `tick()` runs once a second in a supervisor task
  started in the app lifespan (exceptions are logged, never fatal). All state changes take one `asyncio.Lock`, so
  an acknowledgement and an escalation can't interleave. Timestamps are stored, not timers, so a restarted coordinator
  continues exactly where it was; the clock is injectable and the tests drive `tick()` with a fake clock.
- **Escalation.** Contacts are grouped into levels by priority. Each level gets `ack_timeout_s`; after the last
  level every enabled contact is re-alerted every `2 × ack_timeout_s` as a new round. If every notification at the
  current level failed or was declined, the next level is alerted in the same tick. Only a person's "I'm on my way"
  (or the simulated monitoring service) moves an alert to acknowledged.
- **Notifications.** One row per message with its purpose (`alert`, `stand_down`, `all_clear`), level, round,
  delivery status (`delivered` for simulated phones, `sent` when the provider accepted it, `failed` with a reason)
  and the contact's response. Alert messages carry a per-message `secrets.token_urlsafe(18)` token; the token is
  never returned by `/api`.
- **Channels.** `DemoChannel` stores the message for the simulated phones (a presenter fault can make the first
  level unreachable). `TwilioChannel` posts to Twilio's REST API with `urllib` in a worker thread (SMS, plus a
  `<Say>` voice call for `sms_call` contacts), and is only constructed when all three `TWILIO_*` variables exist.
- **Responder page.** `/respond/{token}` sits outside `/api`, so it needs no coordinator token; it is server-rendered,
  escaped HTML with no JavaScript, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a CSP of
  `default-src 'none'`. Actions are form POSTs with a redirect afterwards. Ending an alert goes through a
  confirmation page. Once an alert ends the page shows only that it ended.
- **Watch over me.** Heartbeats come from a dedicated Web Worker (main-thread timers are throttled in background
  tabs). The watchdog fires once per silence; check-ins and the optional signal-unavailable alert use the same
  monitor state, stored in `system_state`.
- **The person's screen.** `LifelineProvider` polls status (every second while anything is open), runs the blink
  detector on every vision frame regardless of input mode, keeps unsent help requests in `localStorage`, and drives
  the alarm. `LifelineOverlay` is a `data-dwell-scope="modal"` dialog, so while it's open eye control can only select
  its own buttons; Cancel carries `data-dwell-scale="2"`.

## Notable tradeoffs

- **Polling, not WebSockets.** The interface polls (1 s for an open case). Simpler, robust to the Pi dropping off the
  network, and cheap at this scale.
- **In-process demo services behind a tool interface**, with their own tables and endpoints, instead of separate
  processes. Keeps the Pi footprint small; the adapter boundary is where real providers would plug in.
- **stdlib `sqlite3` with a lock** rather than an ORM: one user, short transactions, no native build on the Pi.
- **Model-adapted plans rather than model-invented workflows**, so cloud planning can't produce an unexecutable or
  unsafe plan; the validator is the gate either way.
- **Approvals per action with an "approve all" packet**, so a gaze user approves a set of reviewed actions in two
  selections instead of many, while each action stays individually inspectable.
