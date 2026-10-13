# Report: Task 7, daily living (`agent/daily-living`)

## What I built

**My day** (`frontend/src/daily/`, `#/day`): four tabs, every screen fitting a 1280 × 800 screen with no scrolling,
96 px targets 24 px apart.

- **Today**: the day's appointments, visits, care and reminders (set by the person or a helper), one-look **Done**,
  **Later** (back in 30 minutes) and **Tell my carer**, **Read my day** out loud, and **Remind me**: the person adds
  their own reminder in two looks. Rows never move when something is marked, so the next row never slides under
  the person's gaze.
- **Care**: care routines that ask, not tell (changing position, eye drops, mouth care, water, or custom), only in
  waking hours, with Done, Later (snooze) and Tell my carer. A gentle announcement once when one starts asking; no
  pop-ups. The screen says they are not medical advice and not an alarm.
- **Home**: device tiles (lights, TV, fan, heating, blinds) through named Apple Shortcuts in the Mac app, or a
  practice home in the browser and web demo. Heating, ovens and anything a helper ticks need a confirmation look.
  Never locks, doors, garage doors or gates.
- **Ask for help**: six non-urgent tiles ("I'm cold", "Turn me, please", "I need the bathroom"...), said out loud or
  sent to the chosen carer, with the screen pointing to Help for emergencies.
- **Home screen**: a My day card in the usuals row shows what's next. Home's twelve tiles are unchanged.
- **Settings, For a helper, My day and home** (`#/settings/daily`): telling a carer (on/off, who), the day's items,
  care reminders, home devices and shortcuts, and a practice sample day.

**Telling a carer** (`backend/agency/daily/`, `/api/daily/*`): off by default. `prepare` returns the exact words,
who gets them and how; the person looks again to confirm; `send` sends that ticket once. Through Lifeline's existing
`ChannelRouter`: a simulated phone for practice contacts, a real text only with Twilio, **never a call and never an
alert**. Rate limited (6 in 10 minutes), no repeat of the same words within a minute, tickets expire in 5 minutes.
Its table is created by the module itself, so it takes no migration number (task 3 already uses migration 6).
Requests to practice contacts show on the simulated phones page.

**The home in the Mac app** (`os/desktop/src/main/home/`, `os/contracts/src/home.ts`): main runs only shortcuts a
helper saved, with `execFile("/usr/bin/shortcuts", ["run", "--input-path", <file>, "--", <name>])`: no shell, the
name after `--`, a value only through a private temp file. Locks, doors, garage doors and gates are refused by name
in setup, on load and before every run; confirmation enforced in main; one run at a time, 12 a minute, 20 s timeout;
Stop aborts a running shortcut. Setup in `<userData>/home.json`, off until switched on.

Full guide: [docs/DAILY_LIVING.md](../../DAILY_LIVING.md).

Shared-file hooks (small): `App.tsx` (two routes, the nudge), `Home.tsx` (the card, one slot), `OsSettings.tsx` (one
helper item), `PhoneSimulator.tsx` (one component), `os/desktop/src/main/app.ts` (construct, one IPC handler, Stop),
preload, `os/contracts` (`ipc.ts`, `host.ts`, `index.ts`), `backend/agency/main.py` (one router).
Also: `frontend/e2e/backend.ts` and `playwright.config.ts` take `AGENCY_E2E_PORT` / `AGENCY_E2E_BACKEND_PORT`
(defaults unchanged) so two checkouts can run end-to-end tests at once.

## How to try it

- Browser: `make demo`, open `http://localhost:8000/#/day`. Practice home; telling a carer goes to the coordinator's
  simulated phones once a helper turns it on in Settings, For a helper, My day and home (`#/phones` shows it).
- Practice sample day: in settings, **Use a sample day** (or `localStorage["agency.fakes"]` including `daily`).
- Mac app: make shortcuts in the Shortcuts app, add them in settings, switch Home control on (see the guide).

## Test results (run here, on this Mac, 12 October 2026)

After merging the latest `origin/main` (with the caregiver companion; conflicts were "keep both" in `main.py`,
`App.tsx`, `OsSettings.tsx` and `e2e/backend.ts`): backend pytest 328 passed; frontend vitest 251 passed (25 files);
tsc, eslint, prettier, ruff, mypy clean; contracts and desktop typecheck pass; desktop vitest 184 passed; e2e
`daily`, `screens`, `flows`, `desktop-ui` and `lifeline` specs 34 passed. Before the merge:

| Check | Result |
|---|---|
| frontend `npx tsc -b` | passes |
| frontend `npx vitest run` | 237 passed (24 files); 30 new in `tests/daily.test.ts` |
| frontend `npx eslint .` | clean |
| frontend `npx prettier --check src tests e2e` | clean |
| frontend e2e `e2e/daily.spec.ts` | 9 passed (practice mode and a real coordinator; fit at 1280 × 800 and 1440 × 900) |
| frontend e2e, whole suite | 71 passed, 3 failed, 3 skipped (12.9 min). The 3 failures (`camera-denied.spec.ts`, `eyes.spec.ts` "the drawn cursor", `gaze-ai.spec.ts` "sharp tracking") fail the same way on unmodified `main` (df6c814) on this Mac, so they are not from this branch |
| backend `pytest -q` | 264 passed (14 new in `tests/test_daily.py`) |
| backend `ruff check .`, `ruff format --check .`, `mypy agency` | clean |
| `os/contracts` typecheck | passes |
| `os/desktop` typecheck (all three tsconfigs) | passes |
| `os/desktop` `vitest run` | 184 passed (42 new in `test/home.test.ts`, `test/home-ipc.test.ts`) |

E2E ran with a cached `chrome-headless-shell` (Playwright build 1243) via `PW_CHROMIUM`, because this Mac's
Playwright 1.56 browser download was stuck behind another checkout's hung install.

## What I couldn't verify

- **A real shortcut changing a real device.** This Mac has no shortcuts and no HomeKit home. Verified only that
  `shortcuts run --input-path <file> -- <name>` parses and fails cleanly ("Couldn't find shortcut", exit 1) for a
  missing name, and everything else with a faked tool. Which macOS prompts appear when AGENCY.app runs a shortcut
  is unknown.
- **The Electron e2e** (`make os-e2e`) was not run: it opens full-screen, always-on-top windows on the Mac in use.
  The IPC role checks and Stop are covered by unit tests through `AgencyApp`'s real `registerIpc`.
- **A real text to a carer**: tested with a faked Twilio transport only (one SMS, no call).
- **Calendar import**: not built. The native helper has no EventKit access, permission kind or usage string;
  adding them touches several shared places (contracts, Swift helper, permissions, onboarding).
- No real person with ALS has used any of this.

## Next steps

1. Calendar import through the native helper (EventKit, read-only, with its own permission step).
2. Try real shortcuts with a HomeKit light on a Mac; note the prompts in the guide.
3. Home Assistant / Matter as a second home source (ROADMAP), with the same refusal and confirmation rules.
4. Let the caregiver companion (task 3) edit the day and routines from a phone; today they live on the Mac only.
5. Regulatory read before describing home control or care reminders for any medical purpose (21 CFR 890.3725).
