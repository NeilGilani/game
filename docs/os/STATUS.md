# AGENCY OS: status

What is integrated, where it was verified, what is simulated, and what doesn't work yet. Kept current by
Instance 1. "Verified" means a test or measurement actually ran; the place it ran is named.

Last updated: 2026-10-10.

## Contracts

- Version 0. Additive changes on 2026-10-10 (no bump): `host.ts` (`AgencyApi` = `window.agency`, `NATIVE_ALLOWED`,
  `HostToAgent` / `AgentToHost`, `HOST_ENTRIES`, `HostStatus`, `StopAllResult`, `HelpResult`, `OverlayDisplay`,
  `OverlayMode`, `CoordinatorChoice`), new IPC channels in `ipc.ts` (`nativeEvent`, `shellTargets`,
  `overlayInteractive`, `overlayDisplay`, `permissions`, `host`), and a note in `native.ts` that events are
  `{"method":"event","params":NativeEvent}` notifications with logs on stderr.

## Desktop app (Instance 1)

| Part | State | Verified where |
|---|---|---|
| npm workspaces (`frontend`, `os/*`, `site`), `tsconfig.base.json`, `make os-*` targets | Done; `make check` includes `os-check` | Developer Mac (macOS 26.6.2, Apple M5 Pro): `make check` passes. CI: see below |
| Web app unchanged (`make demo`) | Works | Developer Mac: coordinator serves the built interface on :8000 |
| Shell window, `agency://` protocol, CSP, `/api` proxy with token | Done | Electron smoke tests, developer Mac |
| Overlay per display: transparent, on top, all Spaces, click-through except own targets | Done | Smoke test checks one overlay per display, a zero-alpha captured pixel, always-on-top, not focusable, on all workspaces, click-through toggling |
| Built-in fallback overlay (gaze cursor, dwell, Help, Stop) | Done, used until `os/overlay` lands | Smoke tests click Help and Stop |
| Gaze host window (camera only there) | Done; waits for `os/gaze`. Mouse is the gaze source until the engine publishes | Smoke test: shell's `getUserMedia` is refused |
| Typed `window.agency` preload, per-role checks | Done | Smoke tests: round trip to the fake native helper; `input.type` and `screen.capture` refused from the shell |
| Supervision of agency-native, agent, coordinator (health, backoff, logs) | Done | Unit tests (fake timers); smoke tests see all three running |
| Coordinator sidecar (PyInstaller onedir) | Done | Developer Mac: 47.7 MB, 397 ms median startup; packaged app ready in 0.9 to 1.0 s |
| Raspberry Pi coordinator | `host.setCoordinator` + env vars; no UI yet (Instance 7 Settings) | Not yet tested against a real Pi |
| Lifeline heartbeat from main every 5 s | Done | Smoke test: heartbeat accepted by the real coordinator |
| Help (overlay, gaze `help-signal`, API) surfaces the shell and posts `/api/lifeline/help` | Done | Smoke tests: alert opened in the real coordinator; with the coordinator down, the shell still surfaces and retries continue |
| Global Stop (overlay, API, hotkey `⌘⇧⎋`) reaches agent and native at once | Done | Smoke test: fake agent and fake native both log the stop within 500 ms of each other; hotkey registration checked (the key press itself isn't simulated) |
| Onboarding (5 permissions, plain language, live status, deep links, resumable, dwell) | Done | Smoke test: completed with the mouse across a restart; buttons ≥ 96 px. Real TCC prompts not exercised in CI |
| Packaging: `.dmg`, hardened runtime + entitlements when signed, ad-hoc otherwise | Done | Developer Mac: unsigned arm64 `.dmg` (161 MB), `codesign --verify --deep --strict` passes, packaged app starts its coordinator |
| Signing and notarization | Wired to `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Not run: no secrets configured |
| CI (`ci.yml`) and release (`release.yml`, tags `v*`, arm64 + x64, SHA256SUMS) | Written | CI: see below. Release: not run (needs a tag; publishing is the owner's call) |

## Other instances

| Instance | Integrated into main | Notes |
|---|---|---|
| 2 Gaze | Not yet | Host ready at `os/gaze/dist/engine.html` |
| 3 Native + overlay | Not yet | Branch `os-3-native-overlay` exists. Host ready for `os/overlay/dist` and the agency-native binary |
| 4 Agent | PR #1 open | Host speaks the agent's protocol; merge after CI runs on it |
| 5 Bridge + sandbox web | Not yet | Web targets: main merges a `web` snapshot source; the bridge's path into main is still to be agreed |
| 6 Memory | Not yet | Branch `os-6/memory` exists |
| 7 Home, flows, Lifeline UI | Not yet | Needs: `window.agency` detection, `publishShell` targets, `lifeline.onSurface`, heartbeat worker standing down in the app |
| 8 Talk and task packs | Not yet | |
| 9 Landing page | Not yet | Downloads come from GitHub Releases (`AGENCY-<version>-arm64.dmg`, `-x64.dmg`, `SHA256SUMS`) |

## M1 slice

| Step | State |
|---|---|
| App launches with shell and overlay | Works (developer Mac) |
| Overlay gaze cursor (mouse provider) and dwell on real Finder / Chrome buttons | Host side works with the fake native helper; real buttons need agency-native (Instance 3) |
| Home tiles and usuals from memory | Needs Instances 6 and 7 |
| Agent orders food on the sandbox store with an approval | Host plumbing verified with the fake agent; needs Instances 4, 5 and 8 |
| Help on the overlay starts a Lifeline alert | Works (developer Mac smoke test) |

## Simulated or fake

- `os/desktop/fakes/fake-native.cjs` and `fake-agent.cjs` are used in development and tests only. The packaged app
  never uses them; it reports missing parts as `absent`.
- Lifeline contacts and dispatch remain simulated as before.

## CI runs

| Run | Commit | Linux (ubuntu-latest) | macOS (macos-15 arm64 image 20260907) |
|---|---|---|---|
| [38078930259](https://github.com/NeilGilani/game/actions/runs/38078930259) | `[OS-1] Answer Instance 3's integration requests` | `make check` passed (backend 112, frontend 56, desktop 31 tests), browser e2e 14 passed | `make os-check`; Electron smoke tests 12/12 passed; sidecar 52.7 MB, 386 ms median startup; unsigned arm64 `.dmg` built; packaged app's coordinator ready in 1215 ms; `codesign --verify --deep --strict` ok |

## Answers to integration requests

**Instance 3 (os/overlay/INTEGRATION_REQUEST.md)**

1. Preload: `window.agency` is typed (`AgencyApi`, `os/contracts/src/host.ts`) rather than generic
   `invoke/send/on`, so main can check each call. Mapping: gaze `agency.gaze.onEvent`; targets
   `agency.targets.onSnapshot`; native `agency.native.call(method, params)` (overlay allowance now: `ax.press`,
   `input.click/scroll/type/key/drag`, `apps.list/launch/activate/hide/frontmost`); Help `agency.lifeline.help("help_button")`
   (main surfaces the shell itself, no separate `lifeline.surface` needed); Stop `agency.stopAll()`; Home
   `agency.showHome()`; interactive regions `agency.overlay.setInteractiveRegions(rects)` (global points; main
   watches the cursor at 30 Hz and toggles click-through); memory `agency.memory.suggestions(surface, limit)` and
   `agency.memory.event(event)`. Display bounds are in the query string (`?display=&x=&y=&w=&h=&scale=`), and
   `agency.overlay.display()` returns them too.
2. Shell targets: agreed, keep `dwellShellTargets: false` by default.
3. Added `input.drag`, `apps.hide`, and the `input.scroll` units note to `native.ts`. Precision decisions wait for
   Instance 2.
4. Shared dwell/scan code: noted for Instance 2.
5. Root wiring: `make check` runs `npm run check` in every `os/*` workspace that has one (npm workspaces, so no
   separate `npm ci`). The overlay's Playwright run joins `make e2e` when it lands.

**Instance 4 (os/agent/INTEGRATION_REQUEST.md)**

1. `make check` runs `npm run check -w @agency/agent` automatically once `os/agent` is on main (workspace loop).
2. The host now speaks your protocol exactly (`HostToAgent` / `AgentToHost` in `host.ts` are your messages), forks
   `os/agent/dist/agent-utility.mjs`, enforces `AGENT_NATIVE_ALLOWED` (your list) in main, answers `bridge` rpc with
   "The AGENCY Bridge is not connected" until Instance 5 lands, and passes `AGENCY_COORDINATOR_URL`,
   `AGENCY_COORDINATOR_TOKEN`, `AGENCY_AUDIT_FILE`, `AGENCY_AGENT_SETTINGS`. Stop sends `stop.all` to you and
   `input.stopAll` to agency-native directly. Optional: answer `{kind:"ping",id}` with `{kind:"pong",id}` and main
   will health-check you; otherwise it checks liveness only.
3. `task.audit` / `audit.read` and the `screen.capture.scale` note: queued, will add when the UI needs them.
4. `browser.ts`: waiting to agree it with Instance 5.
