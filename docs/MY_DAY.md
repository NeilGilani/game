# My day

My day helps a person who can only move their eyes run their own day: what's next, gentle care routines, the
lights and TV, and asking for help without raising an alarm. It is on Home as **My day**.

AGENCY is not a medical device. Routines are reminders with times the person or their care team chose. They are
not medication advice and not clinical alarms, and nothing happens if one isn't answered. Emergencies go through
Lifeline, which My day never touches.

## What the person sees

- **My day** (a hub of five big choices): the routine waiting for an answer or the next plan as the heading,
  **Today**, **Routines**, **The home**, **Ask for help** and **Read my day** (read aloud with the person's voice).
- **Today**: the day's appointments, visits, care and reminders in order, two to a page, the next one marked.
  Each has one-look **Done**, **Later** (30 minutes) and **Tell my carer**. Turning a page is the only thing that
  moves the list.
- **Routines**: repositioning, eye drops, mouth care, a drink of water, or anything a helper adds. They ask
  ("Time to drink some water?") only during the hours set, at most once per interval since last done, and never
  while put off. **Done**, **In 30 minutes**, **Tell my carer**.
- On other screens a waiting routine shows as a dock button ("Drink some water?") that opens Routines, and as the
  second line of Home's My day tile. It only appears when the screen changes, never in the middle of one, and
  never on Lifeline, Talk or calibration. A helper can have it said aloud once.
- **The home**: each device is a big tile with what AGENCY knows about its state. Choosing one shows its actions.
  Heating and heaters always ask for a confirmation look, placed on the other side of the screen after a pause.
  No doors, locks, garage doors or gates, ever.
- **Ask for help**: seven everyday requests ("I'm cold", "Turn me, please", "I need the bathroom"...) and
  **It's urgent**, which opens Lifeline.
- **Tell my carer** shows exactly what would be sent and to whom ("Send "I'm cold" to Jordan's practice phone?")
  and needs a second, separate look. Then it shows "Sent to Jordan" and, when Jordan answers, "Jordan: On my way".
  When telling a carer is off, the screen says so and offers **Say it out loud** and **Show it big** instead.

## What a helper sets up (Settings, For a helper, My day)

- **Telling a carer**: off by default. Choose one Lifeline contact. A practice contact gets a simulated phone
  (the Simulated phones window shows it, with a working reply link). A contact with a real number gets one real
  text only when the coordinator has Twilio configured. Never a phone call, never repeated, never escalated, and
  every message says it isn't an emergency. At most 6 requests in 10 minutes; the same words within a minute are
  not sent twice.
- **Schedule**: one-off items, every day, or some days of the week.
- **Care routines**: add the usual four in one click, or your own; how often, and between which hours.
- **The Mac's Calendar** (Mac app): show today's events, read-only. Nothing from the Calendar is saved or sent.
- **The home** (Mac app): turn it on, name devices, pick the shortcut for each action.

## The home through Apple Shortcuts (Mac app)

1. In the Shortcuts app, make one shortcut per action, for example **Bedroom lamp on** and **Bedroom lamp off**,
   using the Home app's actions (HomeKit). A shortcut can take text input (for example a temperature) and can
   return text (for a status shortcut: "On", "21°C").
2. Run each one once by hand in Shortcuts and allow anything macOS asks.
3. In AGENCY, Settings, My day, The home: turn on **Control the home**, add each device, and pick its shortcuts
   (AGENCY lists the shortcuts on the Mac). Save.

How it runs: the main process runs `/usr/bin/shortcuts run <name> --input-path <file> --output-path <file>` with
`execFile` (an argument vector, never a shell). The input goes through a private temporary file and the output
comes back through another; both are deleted straight after. A window can only name a device and an action by id;
main looks up the shortcut. Every run needs a ticket from `prepare` and the same fingerprint back, is used once,
runs out after two minutes, and is refused if the setup changed since it was shown. One run at a time per device,
at most 12 a minute, 30 seconds before giving up, no retries. Stop ends a running shortcut and forgets every
ticket. Each run is logged in `<userData>/home-actions.jsonl` (device, action, ok, no content).

Doors: names with lock, unlock, door, deadbolt, garage, gate, keypad, entry, security system, alarm system or
disarm are refused when saved and again before every run, wherever they appear (device, action, shortcut, input).
AGENCY can't see inside a shortcut, so the setup screen tells the helper never to pick one that opens the home.

## How it is built

| Part | Where |
|---|---|
| Schedule, routines, carer requests, the carer's reply page | `backend/agency/daily/` (`/api/daily/*`, `/carer/{token}`) |
| Screens, rules, practice day and practice home | `frontend/src/daily/` |
| Home through Shortcuts (main process) | `os/desktop/src/main/home/`, contract `os/contracts/src/home.ts` |
| Today's Calendar events (read-only EventKit) | `os/native-macos/Sources/AgencyNative/CalendarService.swift`, method `calendar.today` |

Storage: the schedule, routines and settings are small JSON values in the coordinator's `system_state`; requests
are in a `daily_requests` table the service creates itself, so no shared migration number is used. Marks (done,
later) are kept for 14 days and requests for the last 200.

Practice: the web demo, tests (`agency.fakes` with `daily`, `home`) and anyone who picks **Try a practice day**
get a practice day built around the current time and a practice home, both labelled practice. The practice carer
answers "On my way" by itself after a few seconds so the whole path can be seen.

## What has been verified, and what needs a Mac

Verified (see `docs/agent-tasks/reports/agent-daily-living-2.md` for numbers): backend tests, interface unit
tests, the main process's home rules with the `shortcuts` program faked, the native helper's `calendar.today`
handling with a fake platform, Playwright end-to-end tests in practice mode and against the real coordinator,
and Electron tests of the home's IPC and the Calendar path with the fake helper.

Not verified here, needs a Mac with a person's setup:

- A real shortcut changing a real HomeKit device. Running `shortcuts run` from the build agent's terminal hung
  (no shortcut by that name, no GUI session), which is why runs give up after 30 seconds.
- macOS asking for Calendar access and EventKit returning real events, from the signed app. The usage strings
  and the `com.apple.security.personal-information.calendars` entitlement are in place; which process macOS
  attributes the permission to (AGENCY.app or the helper) needs checking on a signed build.
- A real text to a carer through Twilio (covered by tests with a fake transport).
