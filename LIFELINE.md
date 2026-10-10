# Lifeline: calling for help without speaking or moving

Lifeline is the part of AGENCY meant for the worst moment of someone's day. A person with advanced ALS, a
high spinal cord injury or locked-in syndrome often can't shout, reach a phone, press a pendant or say "Alexa,
call Jordan". If their ventilator mask slips at 3 a.m., they may have no way to tell anyone. What they often still
have is control of their eyes, and AGENCY already turns that into reliable input.

Lifeline uses it to call for help, and then makes sure help actually comes: it keeps contacting people until a
human answers "I'm on my way". It also notices when the person *can't* signal: the screen freezes, the computer
loses power, or a check-in goes unanswered.

> Lifeline is a demonstration, not a medical device, a ventilator alarm, or an emergency service. It does not
> replace clinical alarms, a personal emergency response system, or calling emergency services. In the demo all
> contacts are simulated phones: nobody real is contacted unless someone deliberately configures real numbers.

---

## Why this matters

- Not being able to communicate is dangerous in care. In a review of 2,355 hospital charts, patients who had a
  preventable adverse event were three times as likely to have a communication problem (odds ratio 3.00, 95% CI
  1.43 to 6.27), and patients with communication problems more often had several such events (46% v. 20%)
  ([Bartlett et al., CMAJ 2008](https://pmc.ncbi.nlm.nih.gov/articles/PMC2396356)).
- Respiratory failure is the most common cause of death in ALS, and many people with ALS use home ventilation
  (non-invasive masks at night, later invasive ventilation).
- When ventilation fails, alarms and disconnections are recurring factors. In a Joint Commission review of 23
  sentinel events involving long-term ventilation (19 deaths), 65% were related to alarms (malfunction, misuse or an
  inadequate alarm) and 52% to a tubing disconnection; most happened in hospital ICUs, and the review dates from 2002
  ([summarised by Relias Media](https://reliasmedia.com/articles/80183-deaths-injuries-often-come-from-multiple-failures)).
  A report in the European Respiratory Journal describes a person with ALS on home ventilation who died suddenly at
  home; the ventilator's alarm log showed a power failure, and there was no battery back-up
  ([ERJ 2010](https://publications.ersnet.org/content/erj/35/2/310)).

Clinical alarms are built into the equipment and sound in the room. Lifeline covers a different gap: **letting the
person themselves raise the alarm, reaching people who aren't in the room, and confirming that someone is coming.**

---

## What happens in an alert

```
 eye signal / Help / switch           watchdog / missed check-in
          │                                     │
          ▼                                     ▼
  countdown (8 s, cancellable)          starts immediately (the person may not be able to cancel)
          │                                     │
          └──────────────► ACTIVE ◄─────────────┘
                              │   alarm sounds on the person's computer
                              │   level 1 (Jordan) alerted, with a personal response link
                              │
          ┌───────────────────┼─────────────────────────────┐
          │ no answer in 45 s │ delivery failed or "I can't │ "I'm on my way"
          ▼                   │  come": move on at once     ▼
   level 2 (Morgan) ──► level 3 (Monitoring) ──► everyone   ACKNOWLEDGED
   again, every 90 s, until someone answers ...             │  alarm stops, chime
                                                            │  others told "Jordan is handling it"
                                                            ▼
                                     "I'm OK" (confirmed) from the person or a contact
                                                            │
                                                            ▼
                                     RESOLVED: everyone who was alerted gets an all-clear
```

Defaults (all configurable in Lifeline setup): 8 s to cancel, 45 s to answer before moving on, 30 s of silence
before the watchdog alerts, check-ins off.

### Asking for help

| How | Works when | Notes |
|---|---|---|
| **Three long blinks** (each about a second, within 10 s) | The camera is on, in any input mode, even with eye control paused | Ordinary blinks are ignored; eyes closed for a long time (resting) and losing the face reset the pattern |
| **Help button** | Always | First in the top bar on every screen, so it's the first choice when scanning; selectable while eye control is paused |
| **A helper's click** | Always | The same Help button with a mouse, keyboard or touch |
| **Watchdog** | Watch over me is on | The coordinator stops receiving heartbeats from the person's screen for 30 s |
| **Missed check-in** | Watch over me is on and check-ins are scheduled | No answer within 90 s |
| **Eye signal unavailable** (optional) | Watch over me is on | The camera can't see the person's eyes for 3 minutes |

### Who is contacted

Contacts have an order. Everyone with the same number is alerted together; each level gets 45 s to answer. After
the last level, everyone is alerted again every 90 s, without end, and the alarm keeps sounding. A failed delivery
or "I can't come" moves on immediately instead of waiting.

Each alert message contains a personal, unguessable link. It opens a plain page (no app, no login, no
JavaScript) with three actions: **I'm on my way**, **I can't come**, and **Riley is safe: end the alert** (which
asks for confirmation). While the alert is open the page also shows the person's **responder card**: how they
communicate, breathing equipment to check first, allergies, medications, how to get in. It also shows "call 911"
(the number is configurable).

The **Demo Monitoring Center** contact simulates a staffed 24/7 monitoring service: it answers 12 s after receiving
an alert. Real services of this kind can dispatch emergency services; AGENCY does not call 911 itself.

---

## Design rules

1. **The coordinator owns the alert.** Timers, escalation and the record live on the coordinator (ideally a
   Raspberry Pi) in SQLite. If the person's computer freezes, crashes or loses power, the alert keeps going.
2. **"Sent" is not "help".** A message being accepted by a phone network is recorded as sent; only a person pressing
   "I'm on my way" stops escalation.
3. **Never give up.** There is no final state in which an alert is open and nobody is being tried.
4. **No approvals during an emergency.** Permission to contact people without asking is given once, in setup, and
   recorded with its time. Without it, Lifeline only sounds the local alarm, and says so.
5. **Hard to cancel by accident, impossible to cancel silently.** Cancel needs a double-length dwell and only exists
   during the countdown. After anyone has been alerted, the only way out is "I'm OK", which is confirmed and sends
   everyone an all-clear.
6. **Fail loud.** If the coordinator can't be reached, the person's computer sounds its alarm at once, keeps the
   request (across reloads), and keeps retrying.

---

## Hazards and mitigations

| # | Hazard | Causes | Mitigations | Verified by |
|---|---|---|---|---|
| H1 | The person can't signal | Camera off, face out of view, eye control paused, screen frozen | Blink signal works in every mode and while eye control is paused; Help is first in scanning order and always selectable; watchdog; check-ins; optional signal-unavailable alert; readiness checklist shows whether the eye signal currently works | `three long blinks call for help` (e2e), `test_watchdog_*`, `test_missed_check_in_raises_an_alert`, `test_signal_unavailable_alert_is_optional` |
| H2 | The alert doesn't reach anyone | Phone off, wrong number, provider or network down | Per-message delivery status; immediate fail-over; repeating rounds; local alarm; optional monitoring service; phone numbers validated (E.164); readiness warns when real contacts are set but Twilio isn't configured | `unreachable caregiver ... fails over` (e2e), `test_unreachable_first_contact_fails_over_without_waiting`, `test_never_gives_up_when_nobody_can_be_reached`, `test_twilio_failures_are_reported_not_hidden` |
| H3 | Message delivered, nobody comes | Asleep, phone silenced, can't come | Escalation needs a human "on my way"; 45 s per level; repeats to everyone; voice-call option reads the alert aloud; "I can't come" moves on; withdrawing "on my way" reopens the alert | `test_unanswered_alerts_escalate_and_then_repeat_to_everyone`, `test_decline_moves_on_immediately`, `test_a_withdrawn_acknowledgement_reopens_the_alert` |
| H4 | False alarm | Resting eyes, drowsy blinks, flicker in tracking, a stray dwell on Help | Three deliberate closures of 0.6 to 2.5 s within 10 s; ordinary blinks ignored; long closure and face loss reset; hysteresis on the blink score; 6 s refractory period; 8 s cancel window with a pre-alert beep; Help needs a double-length dwell | `pattern.test.ts` (10 tests), `Help starts a countdown that can be cancelled` (e2e) |
| H5 | Real emergency cancelled by accident | Gaze lingering on Cancel, a contact mis-tapping | Cancel needs a double-length dwell; selection pauses briefly whenever the emergency screen changes; cancel is refused once anyone was alerted; ending an alert needs a confirmation on both the person's screen and the responder page | `test_cancel_is_refused_once_people_have_been_alerted`, `test_contact_can_end_the_alert_...` (confirmation step), e2e |
| H6 | Coordinator restarts mid-alert | Crash, update, power blip | All alert state and timers in SQLite; the supervisor resumes from stored timestamps; the restart is recorded on the alert; the watchdog gives the screen a full period to reconnect | `test_an_open_alert_survives_a_coordinator_restart_and_keeps_escalating` |
| H7 | The person's screen loses the coordinator | Wi-Fi drop, Pi unplugged | The help request is queued on the device (kept across reloads), the local alarm sounds at once, retries every 2 s; during an open alert the screen keeps showing it and says the coordinator carries on by itself | `if the coordinator can't be reached ...` (e2e) |
| H8 | One failure takes out both | Coordinator and interface on the same laptop | Readiness checklist warns "Watchdog runs on this computer" unless the coordinator is on a Raspberry Pi | Manual (shown on the Lifeline screen) |
| H9 | Alarm can't sound | Browser autoplay rules: sound needs one real click or key press first; eye-control selections don't count | Readiness checklist reports it honestly; "Test alarm sound" unlocks it; the visual emergency screen doesn't depend on sound | Manual |
| H10 | Medical details leak | Forwarded message, old link, search engines | 144-bit random token per message; the responder card is hidden once the alert ends; `no-store`, `no-referrer`, `noindex` and a strict CSP; `/api` stays behind the coordinator token; everything escaped | `test_responder_page_escapes_everything_and_sets_safe_headers`, `test_tokens_are_unique_and_unguessable`, `test_respond_pages_need_no_coordinator_token_but_the_api_does` |
| H11 | Alert storms | Repeated signals, a long silence | One open alert at a time (repeat signals are recorded on it); the watchdog fires once per silence | `test_a_repeated_signal_never_opens_a_second_alert`, `test_watchdog_fires_once_per_silence` |
| H12 | False watchdog alert | Browsers throttle timers in background tabs | Heartbeats are sent from a Web Worker; the watchdog only runs while Watch over me is on | Not verified over long background periods (see below) |
| H13 | Real people messaged during a demo | Misconfiguration | Simulated phones by default; real texts only with TWILIO_* settings and E.164 numbers; failed simulated deliveries never appear on a phone | `test_demo_lifeline_is_ready_and_uses_only_simulated_phones`, `test_real_channel_through_the_service` |
| H14 | Helper arrives and doesn't know what to do | Person can't speak | Responder card (communication method, breathing equipment first, allergies, access); call-911 line | Responder page tests |

## If something fails

| Failure | What still works |
|---|---|
| The person's computer freezes, crashes or loses power | Coordinator (on a Pi) raises a watchdog alert after 30 s and escalates on its own |
| The coordinator is down | The screen sounds its alarm and keeps retrying; nobody outside the room is contacted until it's back |
| Network between them is down | Same as above; an alert already open on the coordinator keeps escalating |
| The first contact's phone is off | Fail-over to the next level immediately |
| Everyone is unreachable | Rounds repeat every 90 s; the local alarm keeps sounding; the timeline shows each failure |
| Twilio is down or misconfigured | Each message is marked failed with the provider's reason and escalation moves on |
| The Pi loses power | Nothing on the coordinator runs. **Use a UPS or power bank for the Pi** (not provided here) |

---

## Practice: drills and what to measure

Most alarm systems fail quietly: a number changes, a phone stops getting texts, a caregiver doesn't know what the
link is. Lifeline makes practice cheap:

1. Once a month, and whenever contacts change, press **Send a test alert** on the Lifeline screen. Test alerts start
   at once, are labelled TEST everywhere, and ask contacts to press "I'm on my way" to complete the test.
2. Check the **readiness checklist** (contacts, permission, eye signal, alarm sound, independent watchdog,
   real or simulated messages).
3. Practise the blink signal with the person until it works reliably for them; adjust if it doesn't (see limits).

The Lifeline screen reports **time to "on my way"** (typical and slowest), alerts **cancelled in the countdown** (a
rising number suggests false triggers) and **alarm-only alerts** (contacts unusable); each alert's page also shows
the time from the signal to the first message. These are the numbers to watch in a real evaluation.

---

## Regulatory position

Lifeline is positioned like a non-medical caregiver-alerting tool: it relays a person's own request for help and
reports whether someone answered. It makes no claim to detect, monitor or diagnose a medical condition, and it is
not connected to the ventilator. In the US, software that claims to monitor a physiological condition or to work as
a medical alarm can be regulated as a medical device; extending Lifeline in that direction (for example reading
ventilator alarms or pulse oximetry) would require that pathway and clinical validation. It is also not an emergency
service: it doesn't contact 911 itself. A monitoring-service contact, or the people contacted, can.

---

## What has and hasn't been verified

Verified in this repository (all run for the commit that added Lifeline):

- **Backend:** 38 Lifeline tests on a fake clock, covering countdown, cancel, call now, escalation timing, repeating
  rounds, fail-over, never giving up, acknowledgement and stand-down, withdrawn acknowledgement, all-clear,
  consent and alarm-only mode, the responder page (escaping, headers, tokens, confirmation), watchdog, check-ins,
  signal-unavailable, restart persistence, reporting, demo reset, and Twilio (text and call, failures, network
  errors) with a fake transport.
- **Frontend:** 10 Vitest tests of the blink pattern detector.
- **Browser:** 5 Playwright tests against a real coordinator and its real supervisor loop: cancel during the
  countdown; fail-over, a contact answering on the real response page in another window, and ending the alert;
  the three-long-blink signal (with synthetic blink frames) and ordinary blinks being ignored; check-in and
  watchdog; offline queueing across a reload and recovery.
- The coordinator with Lifeline ran on **emulated arm64 Debian Bookworm** (the base of Raspberry Pi OS); see
  [DEPLOY_PI.md](DEPLOY_PI.md).

Not verified, and why:

- **Real people using the blink signal.** The thresholds (0.6 to 2.5 s, three within 10 s) are reasoned defaults.
  They need testing with people with ALS or locked-in syndrome, including when tired, at night, and with ptosis
  or eye dryness, before anyone relies on them.
- **Real text messages and calls.** The Twilio adapter is tested against a fake transport that mirrors Twilio's API;
  no Twilio account was available here.
- **Long background periods.** Worker-based heartbeats are designed to avoid background-tab throttling, but they
  were not tested over hours with the tab hidden. Keep AGENCY visible on screen while Watch over me is on.
- **Physical Raspberry Pi hardware, power loss and UPS behaviour.**
- **Sound without a prior click.** Browsers block it by design; this is reported, not worked around.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Contacts, order, channel | Lifeline setup | Jordan, Morgan, Demo Monitoring Center (all simulated) |
| Consent | Lifeline setup | Recorded for the fictional demo profile |
| Timings, check-ins, signal-unavailable alert | Lifeline setup | 8 s / 45 s / 30 s / off / off |
| Responder card, emergency number | Lifeline setup | Fictional demo card, 911 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Coordinator environment | Not set: real texts and calls are off |
| `AGENCY_PUBLIC_URL` | Coordinator environment | `http://<host>:<port>`, or `http://<hostname>.local:<port>` when listening on the network |
