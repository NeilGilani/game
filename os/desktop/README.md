# @agency/desktop: AGENCY.app

The Electron app that holds AGENCY OS together (owned by Instance 1). It runs the interface full screen as the
person's home, floats an eye-control overlay over every app, hosts the gaze engine, supervises the native helper,
the agent and the coordinator, and keeps Lifeline and Stop reachable at all times.

```
make os-dev     # build everything and run the app from source (windowed)
make os-test    # type-checks, unit tests and the Electron smoke tests
make os-dist    # a .dmg in os/desktop/dist (needs make sidecar; signs only with secrets)
```

## Why Vite + electron-builder (and not electron-vite)

- **The renderers aren't ours.** The shell is `frontend/` (Instance 7), the overlay is `os/overlay/` (Instance 3)
  and the gaze engine is `os/gaze/` (Instance 2). Each already builds with its own Vite config. electron-vite wants
  to own every renderer build in one config; here the desktop package only builds the main process, the preload
  and three small built-in pages, so a ~70-line script calling Vite's API (`scripts/build.mjs`) is simpler and
  keeps every package independently buildable and testable.
- **One fewer moving part between us and Electron.** Same Vite version as the frontend, no extra plugin layer to
  track against Electron releases.
- **electron-builder** handles hardened runtime, entitlements, signing every nested binary (the Python sidecar,
  agency-native), notarization and DMGs, and degrades cleanly to an ad-hoc signed build when there are no secrets.

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Main process | `src/main/` | `app.ts` wires everything; the rest are small testable modules |
| Preload | `src/preload/index.ts` | Exposes `window.agency` (`AgencyApi` in `os/contracts/src/host.ts`) and nothing else |
| Shell window | `agency://shell/` | `frontend/dist`, full screen. `/api` and `/respond` are proxied to the coordinator with the token added by main, so the token never reaches a renderer and Pi mode needs no CORS |
| Overlay windows | `agency://overlay/` | One per display: transparent, frameless, `screen-saver` level, all Spaces including full-screen apps, click-through (`setIgnoreMouseEvents(true, {forward: true})`) except while the pointer is over its own targets. `os/overlay/dist` when built, else the built-in fallback (gaze cursor, dwell, Help, Stop) |
| Gaze host | `agency://gaze/engine.html` | Optional hidden engine window (`AGENCY_GAZE=engine`), `backgroundThrottling: false`. By default the shell tracks the camera and shares its calibrated pointer; main uses the mouse until gaze samples arrive |
| agency-native | child process, JSON-RPC over stdio | `os/native-macos` build, `Contents/MacOS/agency-native` when packaged, `fakes/fake-native.cjs` in development |
| Agent | `utilityProcess` | `os/agent/dist/agent-utility.mjs`, or `fakes/fake-agent.cjs` in development |
| Coordinator | child process | `backend/.venv` in development, the PyInstaller sidecar when packaged (`os/sidecar`), or a Raspberry Pi |

All three processes run under `Supervisor` (`src/main/supervisor.ts`): health checks every 5 s, restart with
exponential backoff (0.5 s doubling to 30 s), a stable run resets the backoff, and logs go to
`~/Library/Logs/AGENCY/<name>.log` (rotated at 2 MB). The packaged app never falls back to a fake: a missing
package is reported as `absent` in `window.agency.host.status()`.

### Security defaults

- Every window: `contextIsolation`, `sandbox`, no `nodeIntegration`, no webviews, `window.open` denied,
  navigation and redirects outside `agency://shell` / `agency://host` blocked.
- CSP on every response from `agency://` (`src/main/protocol.ts`): `default-src 'self'`, scripts only from the app
  (plus `'wasm-unsafe-eval'` for MediaPipe), no plugins, no framing.
- Permissions: the camera (video only) for the shell and gaze window, nothing else for anyone.
- IPC: main checks the sender's role on every channel. Native methods per role are listed in `NATIVE_ALLOWED`
  (`os/contracts/src/host.ts`); no renderer can capture the screen or reach the coordinator token.

### Lifeline and Stop

- **Heartbeat**: main posts `/api/lifeline/heartbeat` every 5 s with honest fields (the eye help signal is
  `signal_ready` only while the camera engine is tracking a face).
- **Help** (overlay button, `help-signal` gaze event, `window.agency.lifeline.help`, optional hotkey): main first
  brings the shell to the front over everything (all Spaces, `pop-up-menu` level, focus stolen) and tells it to show
  the emergency screen, then posts `/api/lifeline/help`. If the coordinator doesn't answer, the screen still
  surfaces and main retries (1 s doubling to 15 s) until it is accepted. Nothing awaits anything else first.
- **Stop** (overlay Stop, `window.agency.stopAll()`, global hotkey `⌘⇧⎋`): main sends `stop.all` to the agent and
  `input.stopAll` to agency-native in the same tick, then reports both results to every window.

### Environment variables (development and tests)

| Variable | Effect |
|---|---|
| `AGENCY_WINDOWED=1` | Shell in a window instead of full screen |
| `AGENCY_SKIP_ONBOARDING=1` | Go straight to the interface |
| `AGENCY_SHELL_URL=http://127.0.0.1:5173` | Load the shell from the Vite dev server (token injected for `/api`) |
| `AGENCY_COORDINATOR_URL`, `AGENCY_COORDINATOR_TOKEN` | Use an existing coordinator instead of the sidecar |
| `AGENCY_NATIVE_PATH`, `AGENCY_AGENT_ENTRY`, `AGENCY_OVERLAY_DIR`, `AGENCY_GAZE_DIR`, `AGENCY_SHELL_DIR` | Point at a specific build |
| `AGENCY_GAZE=mouse` | Ignore the gaze engine and use the mouse |
| `AGENCY_USER_DATA` | Data directory (default `~/Library/Application Support/AGENCY`) |
| `AGENCY_TEST=1` | Test mode: windowed, no single-instance lock, `globalThis.__agency` for Playwright |

## For the other instances

- **Overlay (Instance 3)**: build to `os/overlay/dist/index.html`. You're loaded with
  `?display=<id>&x=&y=&w=&h=&scale=`; gaze and targets arrive in global points. Call
  `window.agency.overlay.setInteractive(true)` while the mouse is over one of your targets, `false` after.
- **Gaze (Instance 2)**: build to `os/gaze/dist/engine.html`; publish with `window.agency.gaze.publish(event)`.
  Main forwards to the overlay and shell, and turns `help-signal` into a Lifeline help request itself.
- **Agent (Instance 4)**: build `os/agent/dist/agent-utility.mjs`; your parentPort protocol is now the contract (`HostToAgent` / `AgentToHost`) over
  `process.parentPort` (see `fakes/fake-agent.cjs`). Answer `ping` with `pong` within 2 s.
- **Native (Instance 3)**: `os/native-macos/.build/release/agency-native`, newline-delimited JSON-RPC, events as
  `{"method":"event","params":<NativeEvent>}`, logs on stderr. `permissions.status` is the health check.
- **Shell (Instance 7)**: inside AGENCY.app, `window.agency` exists. Publish your selectable targets with
  `window.agency.targets.publishShell(targets)` (client coordinates), listen to `lifeline.onSurface` to show the
  emergency screen, and leave heartbeats to main (the browser heartbeat worker should stand down when
  `window.agency` exists, or the two will disagree about `signal_ready`).
