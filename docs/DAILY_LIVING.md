# Daily living: My day, care reminders, the home and asking for help

A day with ALS is full of small things a person can't do alone: knowing what's next, remembering appointments,
getting the lights or the TV changed, asking to be turned. My day helps them run their own day, by eye.

AGENCY is not a medical device. Care reminders are reminders the person and their care team set up: they are not
medication dosing advice and not clinical alarms, and nothing happens if one is ignored. For emergencies the person
uses Lifeline's Help, which is separate and unchanged.

## What's there

Open it from Home (the **My day** card among the usuals, which shows what's next) or at `#/day`. Four tabs:

| Tab | What the person can do |
|---|---|
| **Today** (`#/day`) | Today's appointments, visits, care and reminders, three to a page. One look for **Done**, **Later** (back in 30 minutes) or **Tell my carer**. **Read my day** says it all out loud. **Remind me** adds their own reminder in two looks (what, then when). |
| **Care** (`#/day/care`) | Care reminders (changing position, eye drops, mouth care, a drink of water, or anything else) that ask during waking hours. **Done**, **Later** (snooze) or **Tell my carer**. When one starts asking, AGENCY says so once through the announcer (spoken only if spoken feedback is on). Nothing pops up over what they're doing. |
| **Home** (`#/day/home`) | A big tile per device with what AGENCY last set it to. The device's buttons are big choices. Heating, ovens and anything a helper ticks need a second, confirming look. Never locks, doors, garage doors or gates. |
| **Ask for help** (`#/day/help`) | Six non-urgent requests ("I'm cold", "Turn me, please", "I need the bathroom"...). Each can be **said out loud** for whoever is in the room, or **sent to the chosen carer**. The screen points to Help for emergencies. |

Every screen fits 1280 × 800 without scrolling, with targets of at least 96 px and 24 px apart (`e2e/daily.spec.ts`
checks it), and Home's twelve tiles are unchanged.

A helper sets it up in **Settings, For a helper, My day and home** (`#/settings/daily`), with a keyboard and mouse.

## Telling a carer

Off until the person and a helper turn it on in settings. Then:

- The person chooses **Tell Jordan** (or the helper's chosen Lifeline contact). AGENCY shows exactly who gets what,
  and how ("a text message to their phone", or "their practice phone (simulated)"), with the exact words.
- The **Send** button waits a moment (so a resting look can't press it), then sends that one message once.
- It goes through Lifeline's existing channels (`backend/agency/daily`, `/api/daily/*`): a simulated phone for
  practice contacts, a real text only for a contact with a real number on a coordinator with Twilio. **Never a
  call** (even for a contact set to text and call), **never an alert**, no escalation, no repeats.
- At most 6 requests in 10 minutes, and the same words to the same person within a minute are not sent twice.
  A prepared request runs out after 5 minutes, and turning the feature off drops any that are waiting.
- Practice contacts' requests appear on the simulated phones page (`#/phones`) under "Non-urgent requests".

## The home through Apple Shortcuts (Mac app)

AGENCY runs shortcuts a helper makes; it doesn't talk to HomeKit itself. To set up a lamp:

1. In the **Shortcuts** app on the Mac, make a shortcut called exactly `Bedroom light on` with the Home action
   that turns the lamp on, and another called `Bedroom light off`. Run each once in Shortcuts so macOS can ask
   whatever it needs to.
2. In AGENCY, **Settings, For a helper, My day and home, The home**: add a device "Bedroom light" (a light). Its
   On and Off buttons are filled in with those shortcut names; **List this Mac's shortcuts** helps you pick exact
   names. A button can pass a fixed value to its shortcut (for example `21` for a temperature): it goes to the
   shortcut as its input.
3. Switch **Home control** on and **Save the home setup**.

How it is kept safe (`os/desktop/src/main/home/`, `os/contracts/src/home.ts`):

- Only the shortcuts saved in the setup can run. The person's screen names a device and a button, never a shortcut.
- `/usr/bin/shortcuts run [--input-path <file>] -- <name>` is run with an argument list (no shell). The name comes
  after `--`, and a value goes in a private temporary file, never in the command.
- Names that look like a lock, door, garage door or gate are refused in setup, when the setup is loaded and before
  every run. This check is by name, because AGENCY can't see inside a shortcut, so the setup screen tells helpers
  never to add one that opens or unlocks anything.
- Heating (any thermostat), ovens, heaters and anything a helper ticks need a confirmation look; main refuses those
  without it.
- One shortcut at a time, at most 12 a minute, a 20-second timeout, no retries; Stop aborts one that's running.
- AGENCY can't read a device, so a tile shows what it **last set**, never a live reading.

In the browser and the web demo the Home tab is a **practice home** (a pretend light, TV, fan, heating and blinds)
and says so on screen.

## Where things are kept

- The day, care reminders and the person's marks: this computer's local storage only (`agency.daily.v1`). Nothing
  is sent anywhere.
- The home setup: `<userData>/home.json` on the Mac.
- Telling a carer: the setting is on the coordinator (`daily_settings`); sent requests are kept there (the last
  200, in the `daily_messages` table, created by the daily module itself rather than by a numbered migration).

## Practice mode

The web demo (`VITE_WEB_DEMO=1`) and tests that set `agency.fakes` to include `daily` start with a made-up sample
day, the practice home and a practice carer ("Jordan", a pretend phone on the page). Nobody is contacted and
nothing real changes. A helper can also load the sample day or clear everything in settings.

## Not built yet, and not verified

- **Calendar import from the Mac.** The native helper has no Calendar (EventKit) access, permission prompt or usage
  description yet, so My day is local only. Adding it means a `calendar.events` native method, a Calendar
  permission kind, and onboarding changes in several shared places; it's left for a follow-up.
- **Real shortcuts.** Verified with a faked `shortcuts` tool in unit tests, and on a real Mac only that
  `shortcuts run --input-path <file> -- <name>` parses and fails cleanly for a missing shortcut. Running a real
  shortcut that changes a HomeKit device from inside AGENCY.app, and the macOS prompts that may appear, need a Mac
  with a set-up home.
- **Real texts to a carer.** Tested with a faked Twilio transport (one text, no call). Not sent to a real phone.
- **Regulation.** "Powered environmental control systems" (controlling household functions, 21 CFR 890.3725) are
  an FDA device category; read [NONPROFIT_PLAN.md](NONPROFIT_PLAN.md#5-privacy-and-medical-device-regulation)
  before describing this feature to anyone as being for a medical purpose.
