# AGENCY overlay (`os/overlay`)

Owned by Instance 3. This is the content of the transparent, always-on-top overlay window that Instance 1
creates, one per display. It makes the person's eyes work in every app: Finder, Mail, Messages, Safari,
Chrome, anything.

## What it does

- **Gaze cursor and dwell rings** that snap to app controls from any source (`ax` from agency-native, `web`
  from the AGENCY Bridge). The ring is an outline around the control; nothing is painted over it.
- **Dwell presses with `ax.press`** (AXPress or AXConfirm in the helper). If that fails, the overlay clicks
  the control's centre with `input.click` and tells the person that's what it did. Web targets go through
  the bridge's `pressWeb` when it's there.
- **"Which one?"** When several controls sit inside the gaze error circle (from calibration), the overlay
  doesn't guess. It shows them as big labelled buttons. With more than 6 it also draws a zoomed, numbered
  map of the area. The panel opens away from the area being looked at.
- **Protected rail**: Help (Lifeline), Stop, Home, Keyboard and Pause eyes, with More between Keyboard and
  Pause. While paused only the protected buttons respond; resuming (and Home or Keyboard while paused)
  takes a 1.5× longer look. Help sends `lifeline.help` and then `lifeline.surface` before anything else
  runs. Stop calls the main process's stop-all and cancels scrolling, drags and one-shot modes.
- **Modes** (under More): Numbers (a numbered badge on every control, plus a paged list of big numbered
  buttons), Scroll (edge zones that page while looked at and stop as soon as the gaze leaves; they only
  exist in this mode, so a glance at an edge never scrolls), Apps (running apps first; activate or
  launch, never quit), Right-click, Double-click and Drag (all one-shot), and Move buttons to the other
  side.
- **On-screen keyboard**: QWERTY with keys of at least 96 pt (alphabetical with fewer columns on narrow
  displays). It has a prediction row: phrases from the memory tree (`surface: "keyboard"`) when the line is
  empty, otherwise words from a local unigram/bigram model. It opens by itself when a text field is chosen,
  away from that field. Return takes a longer look because it can send a message.
- **Password fields**: the keyboard shows only "Hide" and a plain explanation. It never types, shows,
  predicts, learns or logs anything for them. agency-native refuses too (`input.type` on a secure field).
- **Single switch**: the first press starts scanning the overlay's buttons (Help first), and later presses
  select. It reuses `frontend/src/input/scan.ts`.
- **Mouse and keyboard for a helper**: every overlay control is a real `<button>` with an accessible name.

All behaviour lives in pure code (`src/core`, `src/keyboard`). React (`src/ui`) only draws `OverlayView`.

## Run and test

```bash
cd os/overlay
npm install
npm run dev          # http://127.0.0.1:5183 : fake desktop, the mouse is the gaze, Space is the switch
npm test             # Vitest: controller, precision, layout, keyboard, n-gram, and the native fake
npx playwright test  # Playwright over the fake desktop with fake gaze (set PW_CHROMIUM if needed)
npm run check        # lint, format, typecheck, unit tests, build
```

The fake desktop is labelled "Simulated app". It publishes ordinary Mac-sized controls (tiny toolbar
icons, rows, text fields and a password field) as `ax` targets, and a fake Mac records what would have
happened.

## Files

| Path | What |
|---|---|
| `src/core/controller.ts` | The state machine: gaze and targets in, view and host calls out |
| `src/core/precision.ts` | "Which one?" and magnifier decisions (local until Instance 2 publishes them) |
| `src/core/layout.ts`, `geometry.ts` | Rail, grids, paging, and placing panels away from attention |
| `src/keyboard/` | Keyboard layout and n-gram predictor |
| `src/host/host.ts` | What the overlay needs from its window (`OverlayHost`, `OverlayFeed`) |
| `src/host/agencyHost.ts` | Adapter for Instance 1's preload `window.agency` (see INTEGRATION_REQUEST.md) |
| `src/host/fakeHost.ts` | Recording fake host for tests and the demo |
| `src/demo/` | Fake desktop for the browser and Playwright |

## Honest status

- **Verified (macOS 26 arm64 dev Mac, Node 26, headless Chromium 1243)**: 50 Vitest tests and 9 Playwright
  tests over the fake desktop. These are fake gaze and fake targets only.
- **Not verified**: inside the real Electron overlay window, which doesn't exist on `main` yet (Instance 1).
  Not tested with real webcam gaze, against real apps, or with real people. Multi-display has the code path
  (each window filters to its own display) but hasn't been tested.
- **Not done**: a pixel magnifier. The zoomed map draws control outlines and doesn't capture the screen,
  because `screen.capture` is for the agent only. Drag needs an `input.drag` native method (requested).
  The n-gram model is in memory only; persisting it needs the person's consent and a host API.
