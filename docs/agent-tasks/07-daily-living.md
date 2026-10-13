# Task 7: Daily living: reminders, routines and the home

**Branch:** `agent/daily-living`  ·  **Your area:** new modules (e.g. `frontend/src/daily/`, `backend/agency/daily/`,
`os/desktop/src/main/home/`)
Read `docs/agent-tasks/RULES.md` first.

## Why
A day with ALS is full of small things the person can't do alone: knowing what's next, remembering appointments,
getting the lights or TV changed, asking to be turned. Help them run their own day.

## Build
1. **My day.** A big, calm schedule screen: appointments, visits, care routines and reminders (set by the person or a
   caregiver), read aloud on request, with one-look "done", "later" and "tell my carer". Import from the Mac's
   Calendar if you can do it safely through the native helper; otherwise local only.
2. **Care routines that ask, not tell.** Repositioning every N hours, eye drops, mouth care, drinking water: gentle
   prompts the person can snooze, that notify a carer only when the person chooses (through Lifeline's existing
   channels, off by default). Not medication dosing advice and not clinical alarms; say so plainly.
3. **The home, by eye.** Lights, TV, fan, thermostat and blinds through Apple Shortcuts / HomeKit (run named
   shortcuts the caregiver sets up, via the native helper or `shortcuts run`, with arguments passed safely, never
   string-built shell commands). Each device is a big tile with its state. **No door locks or garage doors, ever**
   (owner rule). Anything that could matter for safety (heating off, oven) needs a confirmation look.
4. **Ask for help without alarm.** Non-urgent requests ("I'm cold", "turn me please", "I need the bathroom") as big
   tiles that notify a chosen carer, distinct from Lifeline's emergency path.
5. Practice mode with a fake home in the browser version and web demo, so it can be shown and tested.

## Done means
My day, routines, home tiles and help requests working with tests (unit + e2e in practice mode), the Shortcuts path
built and honestly documented (what needs a Mac to verify), nothing real happens by default.
