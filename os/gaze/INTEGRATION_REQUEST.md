# Integration requests from Instance 2 (gaze engine) to Instance 1

`@agency/gaze` now builds `os/gaze/dist/engine.html` (`npm run build -w @agency/gaze`, so `make os-build` picks it
up) and publishes contract `GazeEvent`s with `window.agency.gaze.publish`. These are the changes the engine needs
outside `os/gaze/`. All contract changes are additive.

## 1. Switch to the engine on its first `sample`, not its first event (os/desktop, main) — needed before relying on the engine

`onEngineEvent` turns the mouse fallback off on the engine's first event of any kind. An engine without a
calibration (every new install, since there is no calibration channel yet; see 3) emits blinks and tracking but no
samples, so a helper would lose the mouse and the person would get no pointer. Until this changes,
`engine.html` publishes **only `help-signal`** while uncalibrated (Lifeline first), and everything once calibrated.

Asked: set `gazeSource = "engine"` on the first `sample` event; keep routing `blink`, `tracking`, `help-progress`
and `help-signal` from the engine at all times (they are what makes `signal_ready` true in the heartbeat). Then I
will make `engine.html` publish everything always.

## 2. Displays for the engine window (os/desktop)

The engine maps gaze to global points across displays (`ScreenSpace`). Today it reads `?x=&y=&w=&h=` from its URL
when present, else `window.screen` (main display only). Asked: load `engine.html` with the camera display's bounds
in the query string (same convention as the overlay), and ideally send `{ type: "displays", displays }` (see 3)
when displays change.

## 3. A command channel into the engine (contracts `ipc.ts`, preload, main)

Calibration, continuous recalibration and the precision helpers need requests into the engine. Proposed:

- `IPC.gazeCommand = "agency:gaze-command"`: main → gaze window, payload `GazeCommand` (defined in
  `os/gaze/src/host.ts`; please move it to `os/contracts/src/gaze.ts`). Shell and overlay send them via main.
  Preload for the gaze role: `agency.gaze.onCommand(listener)`.
- `IPC.gazeHost = "agency:gaze-host"`: gaze window → main → shell/overlay, payload is the non-contract part of
  `HostMessage` (`host.calibration` steps for the shell's calibration screen, `host.precision` answers,
  `host.advice` such as "recalibrate", `host.status`, `host.error`, `host.recording`).
  Preload for the gaze role: `agency.gaze.host(message)`.

`startEngineHost` in `os/gaze/src/host.ts` already implements both sides inside the engine window; wiring is
`agency.gaze.onCommand((c) => host.command(c))` plus routing `host.*` messages.

## 4. Contract additions (os/contracts/src/gaze.ts, targets.ts)

- `help-progress`: optional `closed?: boolean` and `holdProgress?: number` (0..1 progress of the current closure),
  so Lifeline's meter can show the closure filling up, not only the count.
- `GazeSample`: optional `errorRadiusPt?: number` (about 2 sigma of the current estimate) so the overlay can snap and
  draw the error circle honestly.
- `PrecisionDecision` and `PickerButton` (from `os/gaze/src/precision.ts`) for Instance 3's picker and magnifier.
- `GazeEvent` `{ type: "advice"; t: number; kind: "recalibrate"; reason: string }` (plain-language reason) for when
  continuous recalibration sees quality drop.

## 5. Selection feedback from the overlay (Instance 3, via main)

Continuous recalibration learns from confirmed selections. The overlay should send
`{ type: "selection", targetId, rect, t, dwellStartT }` when a dwell (or picker choice) activates a target, and
`{ type: "undo", targetId, t }` when the person undoes it (Back, Cancel, Undo) within a few seconds.

## 6. Precision helpers in the overlay (Instance 3)

Ask for a decision (`{ type: "precision", requestId, targets }`) once the eyes have held a fixation for about
600 ms near targets (`GazeEngine.fixationMs`), not only after a dwell completes: in the simulated benchmark this
took 96 pt targets from 77–85 % correct (15–17 % wrong) to 95 % correct (0–2 % wrong). See README.md.

## 7. Root / CI

- `make check` runs `npm run check -w @agency/gaze` through the workspace loop: no change needed.
- The engine's own Playwright test (`npm run test:e2e -w @agency/gaze`, real MediaPipe in Chromium on the fake
  camera) needs `frontend/e2e/fixtures/.cache/face.y4m` (`make e2e-fixtures`). Optional: add it to `make e2e`.
- Electron's `backgroundThrottling: false` on the gaze window is already set; the engine switches to a timer-driven
  frame loop when the page is hidden (requestVideoFrameCallback does not fire in hidden pages).
