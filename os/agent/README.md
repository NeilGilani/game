# @agency/agent: the agent runtime (Instance 4)

Turns a few choices made with the eyes into a finished, verified task in the person's real browser and apps,
without letting anything consequential happen that the person didn't approve. Runs in an Electron utility process
that `os/desktop` spawns. Speaks `AgentCommand` in and `AgentEvent` out, exactly as in `os/contracts/src/agent.ts`.

```sh
cd os/agent && npm ci
npm run check      # lint, format, strict typecheck, 127 tests (incl. the eval suite), bundle
npm run evals      # the eval table (see EVALS.md)
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
                             └─ else ─────────────────▶ runClaude (claude-opus-5-5)
                                     │ every effect
                                     ▼
                               GuardedTools ─▶ ActionGuard ─▶ bridge / agency-native / computer use
                                                   │
                                     ApprovalGate · AuditLog · SafetySettings
```

**Tool tiers**, most structured first: (a) task packs; (b) the AGENCY Bridge for Chrome (page tree, click and type by
element ref); (c) agency-native (accessibility press, typing, keys, apps); (d) Claude computer use
(`computer_toolset_20260801`: screenshot, click, type, key, scroll) as the fallback for any app. Computer use is refused
for Chrome when the bridge is connected, and members the native helper can't do faithfully (zoom, drag, mouse down/up)
are switched off rather than faked.

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
| Privacy | The first message holds only the goal, the person's selections, up to 6 memory suggestions and the mode. Screenshots exist only in the running task's in-memory conversation and are never written to disk. |

## Claude API details

`claude-opus-5-5` by default (`AGENCY_AGENT_MODEL` to change), adaptive thinking, `output_config.effort` (default
`high`), automatic prompt caching (`cache_control` at the top level; system prompt and tools are static), strict
tool schemas, no forced `tool_choice` (Opus 5.5 rejects it), streaming with `finalMessage()`, server-side refusal
fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), `stop_reason: "refusal"` reported plainly,
typed SDK errors mapped to plain messages. Computer use via `computer_toolset_20260801` with `toolset_name` echoed on
every result. Not yet tested against the live API (see EVALS.md).

## What's real, simulated, untested

- **Real and tested here** (macOS 26.6.2 arm64, Node 26, locally): everything in `npm run check`.
- **Simulated**: the web world, the Mac apps, the person, and the model (hand-written scripts).
- **Untested**: the live Claude API; the real AGENCY Bridge and agency-native; the Electron utility process wiring
  (built, not launched); whether refusal fallbacks interact well with the computer toolset on the fallback model.
- **Not done**: loading Instance 8's packs; live eval runs; an `AgentEvent` for live audit entries (requested).

Integration needs: [INTEGRATION_REQUEST.md](INTEGRATION_REQUEST.md).
