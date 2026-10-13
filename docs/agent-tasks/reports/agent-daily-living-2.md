# Task 7 report: Daily living (branch `agent/daily-living-2`)

**Why the branch name differs:** task 7 was started twice on this machine. Another session owns
`agent/daily-living` in `~/agency-daily`; with the owner's agreement this one moved to `agent/daily-living-2` in its
own worktree so neither overwrote the other. The team can compare the two and keep one.

**This branch is for comparison and does not merge cleanly.** It includes origin/main up to `4cad676`. After that,
`agent/daily-living` was merged into main, and it uses the same paths (`backend/agency/daily/`, `frontend/src/daily/`,
`os/desktop/src/main/home/`), so merging this branch would conflict in 24 files. The owner chose to push it as-is so
the team can compare. Pieces that may be worth carrying over onto main's version: the Mac Calendar through the native
helper (`calendar.today`), the carer's reply page with the answer shown to the person, the dock reminder that never
pushes a screen, the five-across Home layout for more than 12 apps, the e2e port overrides, and the extra axe
coverage.

## What I built

**My day**, a new Home tile (`/day`), and its setup in Settings, For a helper, My day. The full guide is
[docs/MY_DAY.md](../../MY_DAY.md).

1. **My day.** A calm hub of five big choices (Today, Routines, The home, Ask for help, Read my day), with the
   waiting routine or the next plan as the heading. **Today** lists appointments, visits, care and reminders in
   order, two to a page, the next one marked, each with one-look **Done**, **Later** and **Tell my carer**.
   **Read my day** speaks a plain summary with the person's chosen voice. A helper sets the schedule (one day,
   every day, or some weekdays). In the Mac app, a helper can also show **today's events from the Mac's Calendar**
   through the native helper: a new read-only `calendar.today` method (EventKit) in `agency-native`. Nothing from
   the Calendar is saved or sent.
2. **Care routines that ask, not tell.** Change position, eye drops, mouth care, a drink of water, or the helper's
   own. They ask only during set hours, at most once per interval since last done, never while put off.
   **Done**, **In 30 minutes**, **Tell my carer**. On other screens a waiting routine appears as a dock button
   and on Home's My day tile. It shows up only when the screen changes, never under the gaze, and never on Lifeline,
   Talk or calibration. The UI and docs say plainly that these are not medication advice or clinical alarms.
3. **The home, by eye.** Device tiles with their state. Choosing one shows its actions. In the Mac app the main
   process (`os/desktop/src/main/home/`) runs Apple Shortcuts the helper named, with `execFile` and temp files for
   input and output (never a shell, never string-built commands). Every run needs a ticket and its fingerprint,
   is used once, and expires. Heating and heaters always need a confirmation look, placed on the far side after a
   pause. Doors, locks, garages and gates are refused when saved and again before every run. Runs are one per
   device and at most 12 a minute, with a 30-second timeout and no retries; Stop ends a running shortcut. Each run
   is logged locally. Off by default.
4. **Ask for help without alarm.** Seven everyday requests plus "It's urgent", which opens Lifeline. A request goes
   to one chosen carer only when a helper has turned that on (off by default), and only after the person confirms
   exactly what goes to whom with a second, separate look. It is sent once through Lifeline's channels: a simulated
   phone for practice contacts, or one real text (never a call) when the contact has a number and the coordinator
   has Twilio. It is marked "not an emergency", never escalates, is rate limited (6 per 10 minutes), and the same
   words within a minute aren't sent twice. The carer answers from a no-JavaScript page (`/carer/{token}`: "On my
   way", "In a few minutes", "Can't come right now"), and the person sees the answer. While telling a carer is off,
   the screen offers **Say it out loud** and **Show it big**. Lifeline is untouched; a test checks that no alert
   is opened.
5. **Practice mode.** The browser version, the web demo and tests get a practice day built around the current time
   and a practice home, both labelled practice. Anyone on an empty My day can choose **Try a practice day**. The
   practice carer answers by itself so the whole path can be seen.

Code: `backend/agency/daily/` (API, service, carer page), `frontend/src/daily/`, `os/desktop/src/main/home/`,
`os/contracts/src/home.ts`, `os/native-macos/Sources/AgencyNative/CalendarService.swift`.

**Small hooks in shared files:** `backend/agency/main.py` (3 lines), `frontend/src/App.tsx` (routes),
`frontend/src/screens/Home.tsx` (the tile, and the routine note on it), `frontend/src/components/Shell.tsx` (the
dock button), `OsSettings.tsx` (one entry), `PhoneSimulator.tsx` (one line), `frontend/src/styles/app.css` (five
across when Home has more than 12 apps, so it still fits one screen), `os/desktop/src/main/app.ts` and the preload
(the home IPC and Stop), `os/contracts` (`home.ts`, the `home` channel, `calendar.today`), and the native helper's
method table. There are no database migrations: the coordinator data lives in `system_state`, plus a table the
service creates itself.

**Test tooling:** e2e ports can now be moved (`AGENCY_E2E_PORT`, `AGENCY_E2E_BACKEND_PORT`; defaults unchanged)
because several checkouts on one machine kept colliding on 4173 and 8765. `/carer` is proxied in dev and preview.

## How to try it

- Browser: `make dev`, open Home, then **My day**. On an empty day choose **Try a practice day**, or set things up
  in Settings, For a helper, My day. With telling a carer on and Jordan chosen, a request appears in the Simulated
  phones window (`/#/phones`) with a working reply link.
- Mac app: `npm start`, then Settings, My day: turn on the home and add devices with Shortcuts names (setup steps
  are in docs/MY_DAY.md), and turn on the Mac's Calendar.

## Test results (run on this Mac, 12 October 2026)

| Check | Result |
|---|---|
| Backend `pytest -q` (after merging origin/main) | **331 passed** (17 new in `test_daily.py`) |
| Backend `ruff check .`, `ruff format --check .`, `mypy agency` | clean |
| Frontend `tsc -b`, `eslint .`, `prettier --check src tests e2e` | clean |
| Frontend `vitest run` | **243 passed**, 25 files (22 new in `daily.test.ts`) |
| Frontend `npm run build` | built |
| `make os-check` (contracts, desktop, agent, bridge, gaze, overlay, sandbox, tasks) | all pass; desktop 157 tests (15 new in `home.test.ts`) |
| Native helper `scripts/test.sh` (swift build + swift test) | **82 passed** (calendar test and method table updated) |
| Playwright `daily.spec.ts` (practice, real coordinator, Mac app home stand-in) | **9 passed** |
| Playwright full suite, before the merge | 69 passed, 5 failed, 3 skipped. Two failures were mine (Home tiles 20 px apart in the 5-column layout); fixed, and those specs re-ran green. The other three (`camera-denied`, `eyes` drawn cursor, `gaze-ai` sharp tracking) **fail the same way on a clean checkout of origin/main on this machine**, so they are not from this branch |
| Playwright after the merge: daily, screens, desktop-ui, companion, lifeline, axe | **35 passed** |
| axe (WCAG 2.2 AA) with every My day screen added, light/dark/contrast, plus a filled practice day | **4 passed**, zero violations |
| Electron `home.spec.ts` (real main process and IPC) | **3 passed** |
| Electron `app.spec.ts` + `packages.spec.ts` | 15 passed, 1 skipped |

I did not re-run the whole Playwright suite after the merge, only the specs above.

## What I couldn't verify

- **A real shortcut changing a real device.** `shortcuts run` from this agent's terminal hung for minutes (no such
  shortcut, no GUI session), so no real run was verified. That is why runs give up after 30 seconds. The runner
  was tested with a faked `shortcuts` program.
- **Real Calendar access.** I didn't trigger the macOS permission prompt from here. The usage strings and the
  calendars entitlement are in place for the app and the helper. Which process macOS attributes the permission to
  (AGENCY.app or `agency-native`) needs a check on a signed build.
- **A real text to a carer through Twilio.** This is covered only with a fake transport.
- Screenshots of each screen were reviewed at 1280×800, 1440×900 and 390×844 during development. They are not
  committed.

## Decisions the team should look at

- **One-look light changes.** The task asks for big device tiles, with a confirmation only for safety (heating).
  RULES says every real action needs the person's explicit approval of exactly what will happen. I treated the
  action button, which names exactly what happens ("Turn on" on the Bedroom lamp screen), as that approval for
  lights, TV, fan and blinds, behind a helper turning real home control on. Heating always gets a second look. If
  the owner wants a second look for every real change, it is a one-line change in `HomeScreen.tsx` (`p.confirm`).
- **"Tell my carer" takes two looks, not one.** A real message must be approved exactly, so the first look opens
  the confirmation and the second sends.
- **Home now has 13 apps**, five across on screens wider than 1100 px. Other workstreams adding tiles will want a
  real decision about Home's layout.

## Next steps

- Verify Shortcuts and the Calendar on a Mac with a real HomeKit setup and a signed build. Add a GitHub Actions
  macOS job for the Electron tests.
- A Home Assistant path for the home (the roadmap prefers local Matter/Home Assistant), behind the same
  ticket rules.
- Let the caregiver companion (task 3) edit the schedule and routines through `/api/daily/*`, and receive requests
  in the companion instead of a text.
- Done/Later for Calendar events (kept on this Mac), and per-routine "say it aloud".
