# @agency/agent: the agent runtime (Instance 4)

Turns a few choices made with the eyes into a finished, verified task in the person's real browser and apps,
without letting anything consequential happen that the person didn't approve. Runs in an Electron utility process
that `os/desktop` spawns. Speaks `AgentCommand` in and `AgentEvent` out, exactly as in `os/contracts/src/agent.ts`.

The AI model is **Google Gemini** by default (`gemini-3.8-flash` through the Interactions API). Claude stays available
behind the same small provider interface.

```sh
npm ci                                  # from the repository root (npm workspaces)
npm run check -w @agency/agent          # lint, format, strict typecheck, 186 tests (incl. the eval suite), bundle
npm run evals -w @agency/agent          # the eval table (see EVALS.md)
```

## For the UI (Instance 7): use the fake

```ts
import { FakeAgent } from "@agency/agent/fake";
const agent = new FakeAgent({ stepDelayMs: 600 });
agent.onEvent((e) => render(e));           // AgentEvent
await agent.handle({ type: "task.start", request: { id: "t1", goal: "Order my usual Friday dinner", origin: "home" } });
```

It walks a scripted, simulated food order: plan of 4 steps, two memory-ranked choice questions, one purchase approval
(with a fingerprint it checks), and a verified done. Decline fails the task, change asks what to change, pause, resume,
stop and `stop.all` work at any point. In the app, `AGENCY_AGENT_FAKE=1` runs it in the utility process.

## How it works

```
TaskRequest ─▶ AgentRuntime ─┬─ matching task pack? ─▶ runPack   (no API key needed)
                             └─ else ─────────────────▶ runModel ─▶ AgentModel: Gemini (default) │ Claude (optional)
                                     │ every effect
                                     ▼
                               GuardedTools ─▶ ActionGuard ─▶ bridge / agency-native / computer use
                                                   │
                                     ApprovalGate · AuditLog · SafetySettings
```

**Tool tiers**, most structured first: (a) task packs; (b) the AGENCY Bridge for Chrome (page tree, click and type by
element ref); (c) agency-native (accessibility press, typing, keys, apps); (d) computer use (Gemini Computer Use in the "desktop"
environment, or Claude's `computer_toolset_20260801`) as the fallback for any app. Both providers' actions are
translated into one neutral set (screenshot, click, type, key, scroll, wait) that runs through the guard. Computer use
is refused for Chrome when the bridge is connected, and actions the native helper can't do faithfully (drag, mouse
down/up, key down/up, triple and middle click, zoom) are excluded rather than faked.

**Planner and executor.** The model must show a plan of 1 to 8 plain steps before acting. Steps are marked done only
after AGENCY reads the page or app back and finds the expected text (`complete_step`, `finish`). After an approved
consequential action, the proof must be text that was *not* on the page before it, so stale or injected "confirmed"
text can't fake success. If verification fails three times, the task ends as "finished but not confirmed". Budgets per
task: 40 model turns, 80 actions, $2 estimated API spend, 30 s per tool call, 3 attempts per step. Pause holds before
the next model call or action; Stop aborts the in-flight model request, revokes open approvals and calls
`input.stopAll`. Waiting for the person never times out and isn't counted as agent time.

**Choose your own adventure.** `ask_person` takes 2 to 6 short options; the runtime re-ranks them with the memory tree
(`suggestedBecause` shows why) and only allows free text when the model says it is unavoidable. Choices and outcomes
are logged back to memory.

## Safety, enforced in code

All of this lives in `src/guard.ts` and `src/policy/`, not in the prompt. The prompt explains the rules; nothing
depends on the model following them.

| Rule | How it's enforced |
|---|---|
| Consequential actions need approval | Risk = max(code classification of the live target's label/role/form, page hint, model's claim). The model can raise risk, never lower it. Unlabelled clicks and unknown operations count as consequential. |
| Approval binds to the exact action | sha256 over task, op, live target (ref, label, role, origin, URL, point), inputs, page facts (e.g. the total), summary and details. Single use. The action is re-read from the live page after the person decides; if anything changed, the approval doesn't match and the person is asked again (at most 3 times, then it stops). Forged or stale decisions are rejected. |
| Spending limits, site allowlist | Caregiver `SafetySettings`: per purchase ($50 default), per 24 h ($100), allowed origins. A purchase whose total can't be read is refused. The higher of the page total and the model's claimed amount is used. |
| Simulated by default | Consequential actions only run on simulated targets (sandbox origins, test apps) unless simulated-only is off *and* the task isn't a dry run. |
| No secrets | Typing into password, card, CVV or one-time-code fields, or typing text that contains a Luhn-valid card number, a `password:` or a verification code, is refused. Secrets are redacted from tool results and the audit trail. |
| Owner-reserved | Calling or messaging emergency services and unlocking real doors are refused; the person is pointed to Lifeline. |
| Untrusted content | Page, app and answer text is wrapped in `<untrusted>` tags. A detector looks for instruction-like text; on a hit the task pauses and the person chooses "Keep going safely" or "Stop the task". |
| Disclosure | A send or call on a page where the agent typed text without an "AI assistant helped" note is refused. |
| Audit | Every action, refusal, question, answer, approval and verification, with what, why, which approval and result. Optional JSONL file, mode 0600. |
| Provider safety signals | Gemini Computer Use's `safety_decision` can only make AGENCY stricter: `require_confirmation` sends the action through the person's approval (and `safety_acknowledgement` is sent only after they approve and it ran); a blocking decision is refused. Gemini's own prompt-injection detection is on. |
| Privacy | The first message holds only the goal, the person's selections, up to 6 memory suggestions and the mode. Screenshots exist only in the running task's in-memory conversation and are never written to disk. Gemini requests use `store: false`, so interactions (screenshots included) aren't kept on Google's servers. |

## Model providers

The runner only sees `AgentModel` (`src/model/types.ts`): start a session, send the brief or the tool results, get back
tool calls. Providers translate; none of the safety code depends on which one runs.

| | Gemini (default) | Claude (optional) |
|---|---|---|
| Choose | default | `AGENCY_AGENT_PROVIDER=anthropic` |
| Key | `GEMINI_API_KEY`, or keychain service `AGENCY` account `gemini-api-key` | `ANTHROPIC_API_KEY`, or account `anthropic-api-key` |
| Model | `gemini-3.8-flash` (`AGENCY_AGENT_MODEL`) | `claude-opus-5-5` (`AGENCY_AGENT_MODEL`) |
| SDK and API | `@google/genai` 2.28.0, Interactions API (`client.interactions.create`) | `@anthropic-ai/sdk` 0.133.0, Messages API (streamed) |
| Reasoning | `generation_config.thinking_level` low / medium / high, default medium (`AGENCY_AGENT_THINKING`) | adaptive thinking, `output_config.effort` (`AGENCY_AGENT_EFFORT`, default high) |
| Tools | `type: "function"` tools, `tool_choice: "auto"`; arguments checked against the schema in AGENCY before anything runs | strict tools, no forced `tool_choice` |
| Computer use | `{ type: "computer_use", environment: "desktop", enable_prompt_injection_detection: true, excluded_predefined_functions: [...] }`; coordinates 0–999 normalized; a fresh PNG screenshot with every result | `computer_toolset_20260801`; screenshot pixels; `toolset_name` echoed |
| State | `store: false`, full history resent each turn, thought steps resent exactly as received | full history resent; automatic prompt caching |
| Refusals | failed or blocked output → "the AI model declined" | `stop_reason: "refusal"`, server-side fallbacks on |
| Cost budget prices | $0.75 / $3.75 per M tokens in / out, $0.075 cached (paid tier, through 2026-12-31) | $4 / $20, $0.20 cached |

Why `store: false`: the Interactions API stores every interaction by default (55 days on the paid tier), screenshots
included. The safety constitution says screenshots are used only during the task and not kept, so AGENCY runs Gemini
statelessly and accepts losing `previous_interaction_id` and its cheaper implicit caching.

Open questions about Gemini, to settle with the first live run:
- Where exactly `safety_acknowledgement` goes in an Interactions `function_result` (the docs show Python only; we put
  `"safety_acknowledgement": true` in the JSON text item next to the status).
- Whether a desktop-environment result should carry a `url` (the browser examples do; we send `status` only).
- Whether stateless responses echo input steps (we drop any echoed `user_input` / `function_result` steps).
- Gemini's free tier may use data to improve Google's products; use a paid-tier key for real use. The pricing page says
  paid-tier content is not used that way.

## What's real, simulated, untested

- **Real and tested here** (macOS 26.6.2 arm64, Node 26, locally): everything in `npm run check`, and the root
  `make os-check` / `make os-build` that CI runs.
- **Simulated**: the web world, the Mac apps, the person, and the model (hand-written scripts, encoded in each
  provider's wire format by fake transports).
- **Untested**: the live Gemini and Claude APIs (request shapes follow the SDK types and docs, never sent); the real
  AGENCY Bridge and agency-native; the Electron utility process under the real host (built, loads in Node; Instance 1's
  smoke tests use their fake agent); whether Claude's refusal fallbacks interact well with its computer toolset.
- **Not done**: loading Instance 8's packs; live eval runs; an `AgentEvent` for live audit entries (requested).

Integration needs: [INTEGRATION_REQUEST.md](INTEGRATION_REQUEST.md).
