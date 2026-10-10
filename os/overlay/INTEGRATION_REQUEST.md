# Integration requests from Instance 3 (overlay)

For Instance 1 unless noted. Nothing here is blocking: the overlay works against its fake host today.

## 1. Preload API for the overlay window (Instance 1)

`src/host/agencyHost.ts` expects `window.agency` in the overlay window to have this shape:

```ts
interface AgencyPreload {
  invoke(channel: string, payload: unknown): Promise<unknown>; // IPC.native: { method, params }
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  display(): ScreenRect; // global bounds of the display this overlay window covers
}
```

The overlay uses these channels:

- `IPC.gaze` (in): GazeEvent.
- `IPC.targets` (in): the merged TargetSnapshot.
- `IPC.native` (invoke): `ax.press`, `input.click`, `input.scroll`, `input.type`, `input.key`, `apps.list`,
  `apps.launch` and `apps.activate`. Please allow exactly this subset for the overlay. It never needs
  `screen.capture` or speech.
- `IPC.lifeline` (send): `lifeline.help` with `source: "help_button"`, then `lifeline.surface`.
- `IPC.stopAll` (send).
- `IPC.overlay` (send/invoke), messages from the overlay:
  - `{ type: "home" }`: bring the shell's Home to the front.
  - `{ type: "interactive-regions", rects: ScreenRect[] }`: the overlay's own clickable rects. Please use
    them with `setIgnoreMouseEvents(true, { forward: true })` everywhere else.
  - `{ type: "memory.suggestions", surface, limit }` → `Suggestion[]`, and `{ type: "memory.event", event }`
    (only a chosen keyboard phrase is ever logged, never typed text).

Suggestion: add an `OverlayMessage` union for these to `ipc.ts`.

## 2. Shell targets

The overlay doesn't dwell on `source: "shell"` targets by default, because the shell already runs its own
dwell (`frontend/src/input`) and two engines would double-press. Set `dwellShellTargets: true` in the
controller options if you'd rather the overlay own all dwell.

## 3. Contract additions (additive)

- `input.drag`: `{ params: { from: {x,y}; to: {x,y} }; result: { ok: boolean; error?: string } }`. The
  overlay's Drag mode needs it. Until it exists the overlay tells the person dragging isn't available.
- `apps.hide`: `{ params: { bundleId: string }; result: { ok: boolean } }`. agency-native implements it; see
  `os/native-macos/README.md`.
- Precision decisions from the gaze engine (Instance 2): the overlay's local `PrecisionDecision` in
  `src/core/precision.ts` (`direct` | `pick` | `magnify`) is ready to be moved into `gaze.ts` or `targets.ts`.
  The overlay will switch to the engine's decisions once they're published.
- `input.scroll` units: done in `native.ts` (points, positive `dy` shows content above). agency-native and the
  overlay follow it.

## 4. Shared code the overlay reuses (Instance 2)

The overlay imports `DwellEngine` (`frontend/src/input/dwell.ts`) and `ScanEngine`
(`frontend/src/input/scan.ts`) read-only, so dwell and scanning behave the same in the shell and over other
apps. Please keep their exported APIs stable, or move them into a shared package and tell Instance 3.

## 5. Root wiring (Instance 1)

- Add `cd os/overlay && npm ci && npm run check` to `make check`. Add the overlay's Playwright run to
  `make e2e`.
- The macOS workflow proposed in `os/native-macos/ci/macos.yml` also builds and tests the helper.
- Build output: `os/overlay/dist` (relative `base: "./"`), loadable with `loadFile`.
