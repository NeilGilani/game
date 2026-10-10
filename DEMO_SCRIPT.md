# AGENCY demo

The judges must see: a physical-input constraint, an AI-driven plan, real software execution, a recovery path, a
verifiable result, and why it matters. Everything below is live; nothing is pre-recorded.

Two parts: **the 3 a.m. scenario (Lifeline, 90 seconds)** opens, because it's the reason this exists; then **the
five-minute task demo**. If you only have three minutes, do Lifeline and minutes 2 and 4 of the task demo.

## Lifeline prep (2 minutes, on top of the prep below)

1. On the Lifeline screen, press **Test alarm sound** once with the mouse (browsers only allow sound after a real
   click). The readiness checklist should show **Alarm sound ready**.
2. Open a second Chrome window at **http://localhost:8000/#/phones** (the simulated phones) and put it beside the
   main window, or on a second screen facing the judges.
3. **Lifeline → Presenter controls → "Jordan's phone unreachable"**: on. This shows fail-over (Jordan's phone is off,
   so AGENCY moves to Morgan at once instead of waiting 45 s).
4. The blink signal needs the camera on. In a camera input mode it starts by itself; otherwise open **Camera setup →
   Start camera**. The readiness checklist should show **Eye signal working**. Practise three long blinks once.
5. If the coordinator runs on the Pi and phones can reach it (see DEPLOY_PI.md), the simulated phones show **QR
   codes**: a judge can answer from their own phone.

## The 3 a.m. scenario (90 seconds)

- "It's 3 a.m. Riley has ALS and uses a ventilator mask at night. The mask has slipped. Riley can't speak, can't
  move, can't reach a phone. A pendant or a smart speaker is useless. Riley's eyes still work."
- **Riley closes their eyes for about a second, three times.** The bottom of the screen counts: *Help signal: 1 of
  3, 2 of 3*, then the emergency screen appears: **Calling for help, 8 seconds**, with a soft beep each second.
  (If the camera isn't reliable, look at **Help**, or click it, and say so.)
  "Ordinary blinks don't do this, and there are 8 seconds to cancel with a long look if it was a mistake."
- At zero the alarm sounds: **Help is being called.** Point at the contact list: **Jordan: couldn't reach**, and
  straight away **Morgan: alert sent, waiting for an answer.** "It doesn't wait 45 seconds on a phone that's off."
- In the phones window, Morgan's phone has the alert. **Open as Morgan** (or a judge scans the QR code): the response
  page says **Riley needs help**, and the responder card says *check the mask and tubing first* and how Riley says
  yes and no. Press **I'm on my way**.
- Back on Riley's screen: **Morgan is on the way.** The alarm stops. "A message being sent isn't help. Help is a
  person saying they're coming, and until someone does, AGENCY keeps going: Morgan, then the monitoring centre, then
  everyone again, every 90 seconds, forever."
- **The rescue (optional, 60 seconds).** On Riley's screen: **Tell them what's wrong → Breathing or mask**. It's
  critical, so everyone is alerted at once. On Morgan's response page, tap **Is it your breathing?**: the question takes
  over Riley's screen and Riley looks at **Yes**; the answer appears on Morgan's page. Morgan ticks **Done** on the first
  care-plan steps ("an example plan; a real one is written with the care team"). Morgan taps **Do you want an
  ambulance?**, Riley looks at **Yes**, and a few seconds later the screen says the ambulance is confirmed by **Demo
  Emergency Dispatch (simulated)**. Say it plainly: "In this build the dispatch centre is simulated. Nobody is sent."
- **I'm OK now → Yes, I'm OK.** Morgan gets an all-clear. **Lifeline → Recent alerts** shows the time to an answer;
  open the alert to show what Riley said, the answers, the steps done, the request and the summary for paramedics.
- One more sentence: "If Riley's laptop crashes in the night, the Raspberry Pi notices the silence and calls for
  help by itself." To show it: turn on **Watch over me**, then **Presenter controls → Freeze this computer**. After
  30 s (set 15 s in Lifeline setup to shorten it) the alert starts on its own.

- Power, if there's time: **Presenter controls → Power cut at the ventilator**. Within a few seconds a critical
  **Ventilator power cut** alert starts by itself ("the battery still has time; someone can plug it back in"). The
  power reading comes from a simulated smart plug, not the ventilator. Turn the switch off again and end the alert.

Turn **Jordan's phone unreachable** off again before the task demo.

---

# The five-minute task demo

## Before the judges arrive (5 minutes of prep)

1. Start AGENCY on the MacBook (or `make dev-pi PI=<address>` if the Pi is the coordinator, see DEPLOY_PI.md):
   ```sh
   cd ~/agency
   make demo
   ```
2. Open **http://localhost:8000** in Chrome, full screen, zoom 100%.
3. **Status → Reset all demo data → Yes, reset.** (Fresh demo week, deadline = the coming Friday.)
4. Choose the input you'll demonstrate: **Settings → Accessibility preferences**.
   - **Eye gaze**: Camera setup → Start camera → all checks OK → Calibrate. Use it only if the result says **good**
     or **fair**. Sit still, light in front of you, laptop at eye level.
   - Otherwise **Blink switch** (camera, long blink selects) or **Key switch** (Space selects). Say clearly that the
     key switch is a keyboard standing in for a single physical switch, not computer vision.
5. **Status → Presenter demo controls → "Repair slot gets taken"** (shows "Armed"). This makes the next booking fail
   the way a real double-booking would. Leave the other two off.
6. Go to **Home**.

## Minute 1: the constraint and the interface

- "Riley (a fictional user) has advanced ALS. Eye movement is reliable; hands aren't."
- Point at the status bar: **Coordinator: This MacBook** (or **Raspberry Pi**), **Demo mode: built-in plans** (or
  **Claude · claude-opus-5-5** if a key is configured), and the input chip (**Eye gaze · tracking**).
- Show a selection: look at **Start a task** and hold. The yellow bar fills; at the end it selects. Glance across a
  button quickly to show that passing over it does nothing.
- One line on privacy: "The video never leaves this laptop; only the selection does."

## Minute 2: one intention, three selections

1. **Get my wheelchair repaired**.
2. AGENCY asks only what it doesn't know: **What's wrong with the wheelchair? → Won't charge / battery**.
3. It shows the goal in plain language, what it will ask before doing ("I'll ask before") and what it won't do.
   **Start this task**.

## Minute 3: the agent coordinates the case

- The plan appears (13 steps, with dependencies) and steps turn green with evidence as real tool calls run:
  repair times found, a **draft** request ("Nothing has been booked yet"), the demo funding program's rules,
  **"Still needed: letter of medical necessity"** ("it never claims funding is approved"), a draft funding inquiry.
- It stops: **2 actions need your approval**. **Review and decide** → the packet shows both.
  Optionally open **Review one by one → Explain** to show the plain-language explanation.
- **Approve all 2 → Yes, do all 2.** (The confirm button is on the other side of the screen, so a lingering gaze
  can't confirm by accident.)

## Minute 4: failure and recovery

- The booking **fails**: "That appointment time is no longer available" (someone else took it). The funding inquiry,
  which doesn't depend on it, still goes through and is **verified** with a reference number.
- **What went wrong**: what happened, **what I checked** ("nothing was booked and nothing was charged"), and the
  proposal: find another time and book it, **with your approval**.
- **Review the fix** → the next open time before Friday → **Approve → Yes, do it**.
  (Optionally **Change** first to pick a different time: the approval is re-issued for exactly that time.)

## Minute 5: verified outcome

- AGENCY adds the repair to the calendar and drafts the caregiver message with the **confirmed** time; approve it
  (the full text is shown; delivery is simulated).
- The case reads **"Everything I did has been checked."** with references (DRP-…, DFS-…), what's still open (the
  clinic letter, the program's decision), and "No real company, office or person was contacted."
- **See what happened** → **Tool calls** (each with its idempotency key and attempt) → **Verification checks**
  (expected vs found, from each service's own records).
- Refresh the browser: the case is exactly where it was. (Optional: stop the coordinator with Ctrl-C and run
  `make demo` again; the case is still there.)
- Close: "The user expresses the intention. AGENCY handles the operational complexity. The user remains in control."

## If something goes wrong

| Problem | What to do |
|---|---|
| Camera won't start or tracking is poor | Settings → Accessibility preferences → **Key switch**; say so out loud. |
| Calibration says poor | Use **Blink switch** or **Key switch**; poor calibration is reported honestly by design. |
| Pi unreachable (red banner) | Ctrl-C `make dev-pi`, run `make demo` on the Mac (local coordinator). |
| Forgot to arm the failure | Status → "Repair slot gets taken" before approving, or skip minute 4. |
| Need a clean slate | Status → Reset all demo data (also clears Lifeline alerts). |
| No alarm sound | Click anywhere on the page once (browser rule), or Lifeline → Test alarm sound. |
| Blink signal doesn't trigger | Use the Help button; check Lifeline → "Eye signal working" in the readiness list. |
| An alert is stuck open during the demo | I'm OK now → Yes, or Status → Reset all demo data. |
| Something is mid-run and you need to stop | **Stop agent** (top right). Nothing runs until **Resume agent**. |

## Other things you can show if there's time

- **Resilience**: Status → "Repair provider is slow" before a booking. The provider books but answers too late;
  AGENCY times out, asks the provider, finds the booking, and **doesn't book twice** (Timeline shows `timeout` then
  `reconciled`).
- **Other goals**: Move an appointment (asks which one mid-workflow), a paratransit renewal (two questions, then
  submit and track), or the suggested follow-up: "Ask the clinic for the letter of medical necessity".
- **Say it with phrases**: "My wheelchair needs repair" + "It won't charge" + "Tell Jordan" → the same structured goal.
- **High contrast / text size / dark**: Settings → Accessibility preferences.
