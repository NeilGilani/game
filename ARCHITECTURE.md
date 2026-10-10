# AGENCY architecture

## Shape of the system

```
 MacBook                                              MacBook or Raspberry Pi 4
 ┌──────────────────────────────────────────────┐     ┌────────────────────────────────────────────────┐
 │ Browser (http://localhost: secure context)   │     │ Coordinator (FastAPI, Python 3.11+)            │
 │                                              │     │                                                │
 │ webcam ─▶ MediaPipe Face Landmarker (WASM)   │     │  /api  ─▶ Planner ─▶ Plan validator             │
 │          ─▶ features (iris, head pose, blink)│     │            │  (built-in plans; optional Claude) │
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
                                                        Anthropic API (Claude): interpret goals,
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
| `backend/agency/reasoning` | Optional Claude adapter with structured outputs; deterministic fallback | Bypass the validator or executor |
| `backend/agency/engine` | State machines, execution, approvals, verification, recovery, persistence, runner | Call services except through tools |
| `backend/agency/tools` | The permitted-tool registry: typed inputs, run, verify, lookup, describe, edit | Expose shell, SQL, browser or arbitrary HTTP |
| `backend/agency/services` | Simulated integrations with their own tables and endpoints | Be reached by the engine except via tools |

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

When `ANTHROPIC_API_KEY` is set (`reasoning/provider.py`):

- `interpret_goal`: free text or phrases → a JSON-schema-constrained set of fields; the Goal is still built by the
  deterministic code from those fields.
- `draft_plan`: the model receives the goal, the tool catalog (with JSON schemas) and the built-in plan, and returns a
  plan via structured outputs. If it fails validation, AGENCY uses the built-in plan and says why.
- `explain`: plain-language explanation of an approval, shown labelled as from Claude, next to AGENCY's own facts.

Calls use `client.beta.messages.create` with `output_config.format` (JSON schema), a configurable effort level
(`AGENCY_ANTHROPIC_EFFORT`), prompt caching, and server-side refusal fallback. Errors are caught by type (auth, not
found, rate limit, bad request, API status, connection) and recorded in the provider status shown on the Status screen.
The default model is `claude-opus-5-5` (configurable).

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

When `AGENCY_API_TOKEN` is set, every `/api` route except `/api/health` requires `X-Agency-Token`.

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
