# AGENCY five-minute demo

The judges must see: a physical-input constraint, an AI-driven plan, real software execution, a recovery path, and
a verifiable result. Everything below is live; nothing is pre-recorded.

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
| Need a clean slate | Status → Reset all demo data. |
| Something is mid-run and you need to stop | **Stop agent** (top right). Nothing runs until **Resume agent**. |

## Other things you can show if there's time

- **Resilience**: Status → "Repair provider is slow" before a booking. The provider books but answers too late;
  AGENCY times out, asks the provider, finds the booking, and **doesn't book twice** (Timeline shows `timeout` then
  `reconciled`).
- **Other goals**: Move an appointment (asks which one mid-workflow), a paratransit renewal (two questions, then
  submit and track), or the suggested follow-up: "Ask the clinic for the letter of medical necessity".
- **Say it with phrases**: "My wheelchair needs repair" + "It won't charge" + "Tell Jordan" → the same structured goal.
- **High contrast / text size / dark**: Settings → Accessibility preferences.
