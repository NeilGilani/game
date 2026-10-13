# AGENCY privacy policy (draft)

*Draft, 12 October 2026, written by reading the code on `main` (commit `df6c814`). Not legal advice: a lawyer who
knows California health-privacy law (CMIA), the FTC Health Breach Notification Rule and Washington's My Health My Data
Act should review it before it goes live (see `docs/NONPROFIT_PLAN.md`, section 5). Two parts: the policy itself,
written for families, and a list for the team of places where the code and the promises don't match yet.*

**Before publishing:** fix or accept every item in [Part 2](#part-2-for-the-team-gaps-to-close-before-publishing),
then re-read the code, because this draft describes the code as it is today, including behaviour the team will
probably want to change.

---

# Part 1. The policy

`[[TEAM: replace "we" with the organisation's legal name once it exists, and add its postal address.]]`

## The short version

- **Your camera video never leaves your computer.** It's used to follow your eyes, then thrown away. It's never
  stored or sent anywhere.
- **Speech recognition happens on your Mac.** AGENCY uses the Mac's on-device recognizer and never records audio.
- **AGENCY doesn't send us anything about how you use it.** No analytics, no tracking, no crash reports, no
  advertising.
- **Some features use cloud AI (Google Gemini).** When they do, the words, choices or screen pictures that feature
  needs are sent to Google, normally through AGENCY Cloud, a relay we run that doesn't store what passes through it.
  This document lists every one of those features below.
- **Lifeline shares your details only with the people you choose,** only when you ask for help or it raises an
  alert.
- **Nothing real happens without setup and your approval.** Out of the box, contacts, shops and messages are
  practice versions.

## What stays on your computer

AGENCY keeps these on your Mac (or on the Raspberry Pi, if you use one for Lifeline). We never receive them.

| What | Where | Notes |
|---|---|---|
| Camera video | Nowhere: processed and discarded | Never stored or sent. Websites opened inside AGENCY Browser can't use the camera |
| Eye calibration | The app's storage | Numbers that describe how your eyes map to the screen, not pictures. Kept for the session, or on the device if you choose "remember" |
| What you hear and say in Talk | The app's storage | Recognized on the Mac; audio is never saved. Your spoken phrases (up to 500) are kept so you can say them again, and are also used by Memory |
| Phrase boards and voice choice | The app's storage | |
| Memory (what you usually choose) | The AGENCY database | You can see, change, hide or erase any of it. Encryption is available and off unless you switch it on |
| Tasks and their history | The AGENCY database | Each task's steps, approvals and results, kept so you can see what happened and resume |
| Papers: your details and signature | The app's storage | Name, date of birth, address and a picture of your signature, if you enter them |
| AGENCY Browser history | The app's storage | Up to 500 recent pages. You can clear it |
| Lifeline settings | The AGENCY database | Your contacts, your responder card (how you communicate, breathing equipment, allergies, medications, how to get in) and your permission choices |
| A record of the agent's actions | A file only your Mac user can read | Passwords and codes are blanked out; screen pictures are not kept |
| A record of real messages sent | A file on your Mac | Who, when and how, with a fingerprint of the text rather than the text |
| App logs | `~/Library/Logs/AGENCY` | Technical messages; each log is kept to about 2 MB |

Apart from Memory (when you switch encryption on), this information is stored **unencrypted** on your computer, so
anyone who can use your Mac account can read it. Use a Mac account with a password, and turn on FileVault.

## What leaves your computer, and when

### Cloud AI (Google Gemini)

AGENCY works without cloud AI: if it's off, AGENCY uses its built-in plans and suggestions. When cloud AI is on (the
standard setting), these features send information to Google:

| Feature | When | What is sent |
|---|---|---|
| **Talk: finishing your sentence** | While you build a sentence on the word board, about a second after each word. **On unless you turn it off** on the board | The words you've chosen so far and your last 12 spoken phrases |
| **Talk: suggested replies** | Only after you agree, once per conversation | The line that was heard, your last 3 phrases and up to 10 phrases from your boards |
| **Papers: explaining a letter** | Each time you ask, after you see what will be sent | The text of that letter (up to about 12,000 characters) |
| **Planning a task** | When you start a task from Home | What you asked for (a short description) and the choices you made |
| **The agent doing a task for you** | During a task you started, until it ends or you press Stop | Pictures of your **whole main screen**, including any other windows that are open, taken after each step; the structure of buttons and text in the app or web page it's working in; your request; and up to 6 suggestions from Memory (including health or money items unless Private mode is on) |

**Close anything private on screen before you start an agent task,** or use a second screen for it: the agent sees
everything on the main screen while it works.

**How it gets to Google.** Unless you (or whoever set up AGENCY) added your own Google or Anthropic key, requests go
through **AGENCY Cloud**, a relay on our website (`getagencyos.pages.dev`) that passes them to Google using our
account. The relay:

- doesn't log or store what's in requests or answers;
- keeps only counts of requests, so it can share the AI fairly and stop abuse; each count is set to expire after a
  minute or two days and is cleared out after that;
- knows your installation by a random number made the first time AGENCY uses it (no name, account or email), and
  counts networks under a scrambled form of the internet address, never the address itself.

**What Google does with it.** Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) apply. On the paid
service, which AGENCY Cloud uses `[[TEAM: confirm the key's project has billing enabled before launch]]`, Google says
it doesn't use prompts and answers to improve its products, and keeps them for a limited time to detect abuse. For
the agent, AGENCY also asks Google not to store its turns. If you use your own free-tier key, Google may use what's
sent to improve its products, and people may read it.

**Other AI providers.** If your own Anthropic key is set up, the same information goes to Anthropic instead under
[its terms](https://www.anthropic.com/legal). An optional feature, off unless you turn it on, sends short Memory
summaries (never items marked sensitive or hidden) to Anthropic after you preview them.

**A connection check.** While cloud AI is on, AGENCY checks every couple of seconds that it can reach Google, with a
request that carries no information about you. Google sees your internet address, as with any connection.

**Never sent to any AI:** camera video, pictures of your face or eyes, eye-tracking data, calibration, and audio.

### Lifeline

When Lifeline raises an alert, it contacts the people you chose, in your order:

- **What they get:** your name, what happened (for example "asked for help with an eye signal" or "the computer
  went quiet"), the time, and a personal link.
- **The link** opens a simple page showing the alert and, while the alert is open, your responder card. When the
  alert ends, the page stops showing your card but still shows that the alert ended and its last events. Each link
  is unique to one person and one alert and is hard to guess.
- **By text or phone call** only if someone set up a Twilio account. Twilio then receives your contacts' phone
  numbers and the message text, under [Twilio's privacy notice](https://www.twilio.com/en-us/legal/privacy).
  Otherwise contacts are simulated phones on screen.
- **Smart home** (lights, door, power) only if someone connected Home Assistant. Door unlocking and calling
  emergency services are simulated in this version.

Lifeline only contacts people after you (or the person setting it up with you) give permission in Lifeline setup.
Without permission, it only sounds the alarm on the computer.

### Real messages and orders (off unless turned on)

- **Messages and calls** through your Mac's Messages app go only to your saved contacts, only after you approve
  that exact message. Apple's terms then apply.
- **Food and shopping orders** on your own DoorDash, Uber Eats, Amazon or Instacart account happen only if you turn
  real ordering on, within the spending limit you set, after you approve that exact order. Each shop's own privacy
  policy applies.

### Websites you visit

AGENCY Browser and "Watch & listen" open real websites (for example YouTube or Google). Those sites see your visit
like any browser visit, under their own policies.

### Optional parts

- **Synapse-Mesh**, an optional AI routing layer, is used only if someone runs it and points AGENCY at it.
  `[[TEAM: describe where Synapse-Mesh sends text, if it's offered to users at all; newer versions can send
  generation to a cloud server.]]`
- **A Raspberry Pi coordinator** keeps Lifeline running if the laptop stops. On your home network it uses an access
  code but no encryption, so use it only on a home network you trust.

## What we receive

From the app: **nothing** about you or how you use it. From AGENCY Cloud: counts of requests per installation and
per scrambled network address, set to expire after at most two days. We can't link an installation number to a person.

If you email us, we receive your email. `[[TEAM: say how long you keep support emails and who reads them.]]`

## Our website

- No trackers, analytics, advertising or cookies. Fonts and files come from our own site.
- To show the newest download, your browser asks GitHub about the latest release; GitHub sees that request under
  [its privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
- Your light or dark theme choice is saved in your browser only.
- **The browser demo** keeps your camera in your browser. When you use its practice features, it sends to Google
  Gemini, through our site: the task you chose, and in Talk the practice line, your recent phrases and your
  sentence so far. To prevent abuse, the site counts requests per internet address in the server's working memory.
  The address isn't written to storage; it's dropped when that server restarts or needs the room.
- The site is hosted on Cloudflare, which may keep server logs under its own policy. We don't look at visitor logs.

## Your choices

| You want to | How |
|---|---|
| Stop Talk sending your sentence to AI | Turn off AI finishing on the word board |
| Keep health and money memories away from the agent | Memory settings: Private mode |
| Stop AGENCY learning | Memory settings: Pause learning |
| See or erase what AGENCY remembers | Memory: look, change, hide, or "Forget everything" |
| Clear Talk history or browser history | Talk history: clear; AGENCY Browser: clear history |
| Turn cloud AI off completely | `[[TEAM: today this is only a technical setting (AGENCY_RELAY=off). Add a switch in Settings before publishing.]]` |
| Withdraw Lifeline permission | Lifeline setup: untick permission. Lifeline then only sounds the alarm on the computer |

## Deleting everything

`[[TEAM: today no single control deletes everything; see Part 2. Until there is one, publish these steps.]]`

1. Quit AGENCY.
2. Delete the folders `~/Library/Application Support/AGENCY` and `~/Library/Logs/AGENCY`.
3. In Keychain Access, delete items named `AGENCY` and `AGENCY Memory`.
4. If you used the Chrome extension, remove it from Chrome.
5. If you used a Raspberry Pi, erase its memory card.

There's nothing to ask us to delete: we don't hold your information. AGENCY Cloud's counters expire after at most two days.

## Children

AGENCY is for adults. Its cloud AI provider doesn't allow users under 18. `[[TEAM: the app has no age check today;
decide how to handle this before publishing.]]`

## Health information

Your responder card, phrases and memories can include health information. It stays on your computer except as
described above (AI features you use, and Lifeline alerts to your own contacts). We don't sell or share it, and we
never use it for advertising. `[[TEAM: lawyer to confirm which health-privacy laws apply and what this section must
say.]]`

## Security

The parts of AGENCY on your Mac talk to each other only inside the Mac, with a secret code. We don't have access
to your computer. If you find a security problem, please tell us at `[[TEAM: security contact]]`.

## Changes

If this policy changes, the new version will be on our website with its date, and the change will be visible in
the project's public history on GitHub.

## Contact

`[[TEAM: organisation name, email, postal address]]`

*Last updated: `[[TEAM: date]]`*

---

# Part 2. For the team: gaps to close before publishing

Found by reading the code on 12 October 2026. File references are to `main` at `df6c814`. Nothing here was changed:
code is outside this task's area. Each item needs a decision: change the code, or keep the behaviour and say so
(Part 1 already says so where the behaviour is described).

### The live privacy page (`site/src/pages/privacy.astro`) says things the code doesn't do

| Live page says | Code does | Evidence |
|---|---|---|
| "Every request is routed first by Synapse-Mesh, whose intent Sifter runs on the device" | Synapse-Mesh is used only when `AGENCY_SYNAPSE_URL`/`AGENCY_LOCAL_MODEL_URL` is set; the desktop app doesn't bundle it; otherwise a keyword router runs. Some paths bypass routing | `backend/agency/synapse.py:400-410`, `77-88`; `Makefile:79-86` |
| "screenshots of the app it's working in" | Screenshots of the **whole main display**, all windows, with the cursor | `os/native-macos/Sources/AgencyNative/ScreenCapture.swift:22-28`; `os/agent/src/model/gemini.ts:159-165` |
| "The AI sees only what a task needs, only when you start one" | Talk's AI finishing is on by default and sends words and the last 12 phrases with no task and no consent sheet | `frontend/src/talk/Board.tsx:52-71`; `backend/agency/assist.py:323-350` |
| "Memory is local and yours ... stays on your Mac" | Up to 6 memory suggestions go into every agent prompt; sensitive items included unless Private mode (off by default) | `os/agent/src/runtime/modelRunner.ts:413-429`; `backend/agency/memory/service.py:294-298`; `memory/models.py:137` |
| "AGENCY asks Google not to store the agent's turns" (true) but implies all requests | `store: false` only on the agent's Interactions turns, not on plans, Talk or Papers | `os/agent/src/model/gemini.ts:180`; `backend/agency/reasoning/provider.py:510-530` |
| "With AGENCY Cloud switched off ..." | There's no switch a user can reach; only environment variables | `backend/agency/config.py:92-97`; `os/agent/src/model/cloud.ts:32-35` |
| Web demo sends "the task's text" | Also Talk replies (heard line, recent and board phrases) and sentence completions | `frontend/src/demo/webDemo.ts:257-263`; `site/functions/api/assist/*.ts` |
| "never types, reads or stores" passwords, codes, card numbers | Typing is blocked in code, but full-screen screenshots can show them, and Lifeline stores a dispatch-cancel PIN and an entry note (e.g. a key-safe code) unencrypted | `os/agent/src/policy/secrets.ts`; `backend/agency/lifeline/models.py:101-102` |

Also: `site/src/data/site.ts:33` says a Gemini key is needed for AI tasks; AGENCY Cloud is the default, so it isn't.

### Behaviour to fix or decide on

1. **No user-facing "AI off" switch.** Add one in Settings, and an "on-device only" option (roadmap A2).
2. **Talk AI finishing is on by default without a consent step.** Consider off by default, or a one-time consent
   sheet like Talk replies have (`frontend/src/talk/Board.tsx:52-58`).
3. **Talk replies' consent preview is incomplete.** It shows "Heard + your recent phrases" (3) but sends up to 10
   board phrases as well, and says "through your AGENCY coordinator" without mentioning the relay
   (`frontend/src/talk/Listen.tsx:81-97`, `160`, `211-226`).
4. **Papers' consent sheet** also doesn't mention the relay (`frontend/src/papers/PapersExplain.tsx:30-51`); cloud
   explain is allowed by default (`papers/store.ts:86-88`).
5. **Agent screenshots show the whole display.** Consider capturing only the target window, or blanking other
   windows, and say so in onboarding. The Screen Recording permission text says "Nothing is recorded or kept" and
   doesn't mention that pictures go to the AI (`os/desktop/src/main/permissions.ts:36-40`).
6. **Memory to the agent:** consider sending sensitive items only with Private mode off *and* an explicit choice,
   or making Private mode the default.
7. **"Erase everything" in Settings always fails.** It posts `/api/memory/forget-all` with no body; the API requires
   `{"confirm": true}` and returns 422 (`frontend/src/screens/OsSettings.tsx:394-404`; `backend/agency/memory/api.py:139`).
   Even the working "Forget everything" in Memory leaves Talk history, cases, audit, Lifeline, Papers details and
   signature, browser history, logs and calibration. A real "delete everything" is roadmap item "Data at rest".
8. **No retention limits** for cases, audit events or Lifeline history (`backend/agency/db.py`). Decide how long to
   keep them.
9. **Most local data is unencrypted** (SQLite, localStorage incl. the coordinator token `agency.token`, Papers
   signature). Only memory has optional encryption.
10. **Lifeline response links never expire** and tokens are stored in plain text
    (`backend/agency/lifeline/service.py:266-286`). The card hides when the alert ends; the page still shows the
    last 12 events. Consider expiring links (for example 24 hours after the alert ends).
11. **Consent carried from the demo.** A fresh database seeds Lifeline and dispatch consent as already given for the
    fictional profile (`backend/agency/services/seed.py:74-76`, `108-113`), and `save_settings` keeps the old
    `consented_at` when a real person later adds real contacts without unticking it
    (`backend/agency/lifeline/service.py:117-124`). Require fresh consent when the first real contact is added.
12. **Uvicorn's access log** is on, so request paths (including `/respond/<token>`) may land in
    `~/Library/Logs/AGENCY` (inferred from uvicorn defaults; `backend/agency/__main__.py:36`). Turn it off or
    redact tokens.
13. **`/api/health` is unauthenticated** and returns hostname, OS and version (`backend/agency/main.py:241-255`).
    Fine on localhost; worth trimming for a Pi on a LAN.
14. **Web demo rate limiting** keeps the raw IP in isolate memory, pruned only when more than 5,000 addresses are
    held (`site/functions/_lib/gemini.ts:24-39`); the relay hashes it. Expired relay counter rows are deleted only on
    about 2% of requests (`site/functions/_lib/relay.ts`). Consider hashing here too, so the site policy can say the same thing for both.
15. **Network probe** to Google every 2 s while cloud AI is configured (`backend/agency/network.py:193-207`).
    Harmless, but disclose it (Part 1 does) or slow it down.
16. **No age gate** although Gemini's terms require users to be 18 or older.
17. **AGENCY Browser lets the agent act on any site** (`agentAnySite: true`, `os/desktop/src/main/browser/store.ts:22`)
    for read and reversible actions without approval; consequential actions still need approval and real actions
    are off by default. Make sure the terms and onboarding explain this.
18. **Chrome voices:** in a browser (not the Mac app), text-to-speech may pick a Google network voice that sends the
    text to Google (no `localService` filter, `os/tasks/src/talk/speech.ts:61-79`; inference about Chrome's
    behaviour). The Mac app uses on-device voices.
