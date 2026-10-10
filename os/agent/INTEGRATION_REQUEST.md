# Integration requests from Instance 4 (agent runtime)

For Instance 1 unless noted. Nothing here is blocking the fake agent; items 1 to 3 are needed for the real agent.

> Status 2026-10-10: items 1 and 2 are done on main (STATUS.md). The agent now answers `ping` with `pong`.
> The host already passes its whole environment to the agent, so `GEMINI_API_KEY` needs no host change.
> **PLAN.md still says "Anthropic API" in the architecture diagram and Claude in "What we are building"; the owner
> switched the agent to Google Gemini (Claude optional). Please update PLAN.md (root doc, Instance 1).**

## 1. Run os/agent in `make check` and CI

`os/agent` is a standalone npm package (its own `package.json` and lockfile, pinned versions). Please add to the root
Makefile and CI (ubuntu is enough; nothing in it is macOS-only):

```make
check-agent:
	cd os/agent && npm ci --no-audit --no-fund && npm run check
```

`npm run check` = eslint, prettier check, `tsc` strict, vitest (unit tests + the scripted eval suite), and an esbuild
bundle of the utility-process entry to `os/agent/dist/agent-utility.mjs`.

## 2. Spawn the agent utility process (os/desktop)

Entry: `os/agent/dist/agent-utility.mjs` (built by `npm run build`; `electron` is external). Spawn with
`utilityProcess.fork(...)`. Messages over `process.parentPort` (all structured-clone safe):

| Direction | Message |
|---|---|
| main → agent | `{ kind: "command", command: AgentCommand }` (forward `IPC.agentCommand` from the shell) |
| agent → main | `{ kind: "event", event: AgentEvent }` (forward to the shell on `IPC.agentEvent`) |
| agent → main | `{ kind: "status", status }` once at start: `{ model, bridge, native, packs, note, keySource }` or `{ fake: true }` |
| agent → main | `{ kind: "rpc", id, target: "native" \| "bridge", method, params }` |
| main → agent | `{ kind: "rpc.result", id, result? , error? }` |

- **Native rpc**: the agent only asks for `ax.targets`, `ax.press`, `input.click`, `input.scroll`, `input.type`,
  `input.key`, `apps.frontmost`, `apps.launch`, `apps.activate`, `screen.capture`, `input.stopAll`
  (`AGENT_NATIVE_METHODS` in `src/utility.ts`). Please enforce the same allowlist on the main side.
- **Bridge rpc**: `snapshot`, `click {ref}`, `type {ref, text}`, `navigate {url}`; see item 4.
- **Stop**: the global Stop should send `{ kind: "command", command: { type: "stop.all" } }` to the agent **and**
  `input.stopAll` to agency-native directly; the agent also calls `input.stopAll` itself, but Stop must not depend on it.

Environment variables the entry reads:

| Variable | Meaning |
|---|---|
| `AGENCY_AGENT_FAKE=1` | run the scripted FakeAgent instead (for UI work) |
| `AGENCY_AGENT_PROVIDER` | `gemini` (default) or `anthropic` |
| `GEMINI_API_KEY` | optional; otherwise the macOS keychain item service `AGENCY`, account `gemini-api-key` |
| `ANTHROPIC_API_KEY` | only with `AGENCY_AGENT_PROVIDER=anthropic`; or keychain account `anthropic-api-key` |
| `AGENCY_AGENT_MODEL` | default `gemini-3.8-flash` (or `claude-opus-5-5` for Claude) |
| `AGENCY_AGENT_THINKING` / `AGENCY_AGENT_EFFORT` | Gemini thinking level (default medium) / Claude effort (default high) |
| `AGENCY_COMPUTER_USE=0` | turn the computer-use tier off |
| `AGENCY_COORDINATOR_URL`, `AGENCY_COORDINATOR_TOKEN` | memory API (`/api/memory/*`) |
| `AGENCY_AUDIT_FILE` | e.g. `~/Library/Application Support/AGENCY/agent-audit.jsonl` (written 0600, secrets redacted) |
| `AGENCY_AGENT_SETTINGS` | JSON file with the caregiver's `SafetySettings` (limits, allowlist); re-read on every check, never written by the agent |
| `AGENCY_BRIDGE=0`, `AGENCY_NATIVE=0` | disable a tier |

Never pass the key to renderer code; the agent process reads it itself.

## 3. Contract additions (additive)

**`agent.ts`**: nothing breaking. Two optional additions would help the UI:

- `AgentEvent` `{ type: "task.audit"; taskId; entry: { at; kind; message; approvalId?; result? } }` so the person and
  caregiver can read the audit trail live (today it is only in the JSONL file and `AgentRuntime.audit`).
- `AgentCommand` `{ type: "audit.read"; taskId? }` answered with those entries.

**`screen.capture` result `scale`** (native.ts, with Instance 3): please document it as *image pixels per global screen
point*. The computer-use tier converts model coordinates with `point = pixel / scale`.

## 4. Proposed `browser.ts` contract (with Instance 5)

The agent is built against this interface (`src/types.ts`); the sandbox web world used by the evals implements it.

```ts
export interface PageNode {
  ref: string; role: string; name: string; value?: string;
  secure?: boolean;          // password, card number, one-time code fields: values never sent
  disabled?: boolean;
  autocomplete?: string;     // autocomplete attribute, to spot secret and personal-data fields
  risk?: ConsequentialKind;  // data-agency-risk hint; raises risk only
  submits?: boolean;         // button submits a form
}
export interface PageSnapshot { tabId: string; url: string; origin: string; title: string; nodes: PageNode[]; text: string; simulated: boolean }
export interface BrowserBridge {
  snapshot(): Promise<PageSnapshot>;
  click(ref: string): Promise<{ ok: boolean; error?: string }>;
  type(ref: string, text: string): Promise<{ ok: boolean; error?: string }>;  // must refuse secure fields itself too
  navigate(url: string): Promise<{ ok: boolean; error?: string }>;
}
```

`simulated` should be true only for Instance 5's sandbox origins. The agent refuses consequential actions on
non-simulated targets unless the caregiver turns off simulated-only mode and the task is not a dry run.

## 5. Task packs (with Instance 8)

The agent runs packs without an API key. Interface (`src/types.ts`): `TaskPack { id, title, matches(request),
steps(request): PackStep[] }`, `PackStep { id, title, risk, run(ctx): Promise<{ verified, summary, evidence? }> }`.
`ctx.tools` is the same guarded tool set the model gets, so packs get the same approvals and refusals. Example:
`evals/packs.ts`. The utility entry currently loads no packs; once `os/tasks` exports them, pass them in `packs`.
