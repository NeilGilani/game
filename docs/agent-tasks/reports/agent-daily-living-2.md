# Task 7 report, second session (branch `agent/daily-living-2`)

## What happened

Task 7 was started more than once on this machine at the same time. Another session's version
(`agent/daily-living`, report: `agent-daily-living.md`) was merged into main first. This session built its own
complete My day in a separate worktree. Both used the same paths, so merging main meant choosing one. **The owner
chose to keep main's My day and carry over only what stands alone.** This branch is now main plus those pieces. This
session's own My day (schedule, routines, home tiles, help requests, settings) is no longer on the branch. It
remains in the history before the merge (`d92963a` and earlier) if anyone wants to look.

## What this branch adds to main

1. **Today's Mac Calendar through the native helper: `calendar.today`.** Main's My day says "Calendar import from
   the Mac isn't available yet". This is the missing native part, ready to wire in.
   - Read-only EventKit (`os/native-macos/Sources/AgencyNative/CalendarService.swift`): today only, sorted, at
     most 50 events, titles and places cut to 200 characters. Nothing is written or kept.
   - The first call asks for Calendar access. Without it, the result is `{ ok: false, error }` with the exact
     System Settings pane.
   - Wired through the `NativePlatform` protocol and the server, the contract (`os/contracts/src/native.ts`) and
     the shell's `NATIVE_ALLOWED` (the overlay may not call it). Both TypeScript fakes and the Electron fake helper
     answer it.
   - The usage strings are in the helper's `Info.plist` and the app's `extendInfo`. The
     `com.apple.security.personal-information.calendars` entitlement is set for the app and the helper.
   - Nothing in the interface calls it yet. Wiring it into main's `DaySettings`/`MyDay` is the next step.
2. **Home still fits one screen with more than 12 apps.** `frontend/src/styles/app.css` lays tiles out five across
   on screens wider than 1100 px once there is a 13th tile, with 24 px gaps. With today's 12 tiles nothing changes.
   This version passed the screens test (no scrolling at 1280×800 and 1440×900, targets 24 px apart) when this
   branch had 13 tiles.

## Test results (12–13 October 2026, this Mac, after merging origin/main `412b760`)

| Check | Result |
|---|---|
| Frontend `tsc -b`, `eslint .`, `prettier --check src tests e2e` | clean |
| Frontend `vitest run` | 251 passed (25 files) |
| `make build` | built |
| Backend `pytest -q`, `ruff check .`, `ruff format --check .`, `mypy agency` | 328 passed; clean |
| `make os-check` (contracts, desktop, agent, bridge, gaze, overlay, sandbox, tasks) | all pass (desktop 184 tests) |
| Native helper `scripts/test.sh` | 82 passed (includes the calendar test and the updated method table) |
| Electron `calendar.spec.ts` (new) + `app.spec.ts` + `packages.spec.ts` | 16 passed, 1 skipped |
| Playwright `daily.spec.ts` (main's), `screens`, `desktop-ui`, `axe` | 25 passed |

Not run after this merge: the rest of the Playwright suite. Before it, three camera/gaze specs (`camera-denied`,
`eyes` drawn cursor, `gaze-ai` sharp tracking) failed on this Mac, and they fail the same way on an unmodified
checkout of main.

## What I couldn't verify

- The macOS permission prompt and real events from EventKit. The method is tested with a fake platform and the fake
  helper. Which process macOS attributes Calendar access to (AGENCY.app or `agency-native`) needs a signed build.

## Next steps

- Wire `calendar.today` into main's My day behind a helper's switch: show today's events, read-only, never saved.
- Lesson for the team: parallel sessions on one Mac collided on a worktree, on Playwright's shared browser-cache
  lock, and on the e2e ports (main now has `AGENCY_E2E_PORT` and `AGENCY_E2E_BACKEND_PORT`). One session per task,
  each in its own worktree.
