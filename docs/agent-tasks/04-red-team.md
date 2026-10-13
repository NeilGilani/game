# Task 4: Red team and 8-hour reliability

**Branch:** `agent/reliability`  ·  **Your area:** tests, tooling and small targeted fixes anywhere
Read `docs/agent-tasks/RULES.md` first.

## Why
For someone who can only move their eyes, a frozen screen or a crash isn't an annoyance: they can't fix it, can't call
for help, can't even say something is wrong. AGENCY has to survive a whole day, every day, and fail safe.

## Build
1. **Soak tests.** Run the app (frontend + coordinator, and the Electron app under xvfb if you can) for long simulated
   sessions with injected gaze, blinks, squints, tasks, Talk, browser use and network drops. Track memory, CPU,
   handles, event-listener counts, frame timing and log growth over time. Find and fix leaks. Add a repeatable
   `make soak` with a short CI mode.
2. **Fail safe.** Kill and restart each part (coordinator, gaze engine, agent, browser views, native helper) mid-task
   and check: Help and Stop keep working, the person is told what happened in plain words, nothing consequential
   happens twice, Lifeline still alerts. Fix what breaks. Add a watchdog that brings the app back if the shell hangs.
3. **Security review.** Electron (IPC sender checks, the AGENCY Browser isolation, navigation rules, permission
   handlers), the coordinator API (auth, origins, input bounds), the AI relay in `site/functions` (signing, limits,
   no content logging), real messaging and ordering guards (approval binding, replay, rate limits). Write the
   findings in a report ranked by severity, fix the high ones with tests, and propose fixes for the rest.
4. **Fuzz the edges.** Hostile page content in AGENCY Browser (prompt injection aimed at the agent, fake "Approve"
   buttons, overlays that try to steal dwell), malformed IPC, huge inputs, odd Unicode in messages and AppleScript
   arguments.

## Done means
Soak and fault-injection suites committed and green, every leak or crash you found fixed with a test, a ranked
security report in your branch's report file, and no regressions anywhere.
