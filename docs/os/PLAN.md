# AGENCY OS: the shared plan

This is the source of truth for the nine instances building AGENCY OS in parallel. Read it fully before
writing code. If something here is wrong or missing for your work, don't work around it: write the change you
need in `os/<your-area>/INTEGRATION_REQUEST.md` (or your PR description) and Instance 1 updates this file and
the contracts.

## What we are building

AGENCY OS is a home and an accessibility layer for macOS for people who can't use their hands or voice
(advanced ALS, high spinal cord injury, locked-in syndrome, severe cerebral palsy) but can move their eyes.
It is not a kernel operating system; it runs on macOS and takes over the experience:

1. **Home**: a calm, Launchpad-style screen of big choices, like a choose-your-own-adventure book: *Talk*,
   *Call someone*, *Food*, *Papers*, *Shopping*, *Messages*, *Watch & listen*, *Browse*, *Apps*, *Lifeline*. Every
   path is a short series of big choices that ends in something getting done.
2. **It knows them**: a personal memory tree learns what the person usually chooses (Friday pad thai, the
   pharmacy they use, the phrases they say most) and offers it first, with a plain reason ("4 of your last 5
   Fridays"). They can see, change or erase everything it knows.
3. **It can do any task**: an AI agent (Google Gemini) carries out the task in the person's real browser and apps:
   ordering food, filling and signing forms, booking appointments, sending messages, placing calls in which the
   person speaks through text-to-speech. It asks before anything consequential and checks that it worked.
4. **Their eyes work everywhere**: the eye-control layer floats over every app, snaps the gaze to real buttons
   in any app or web page, and offers zoom and "which one?" pickers for small targets, so even webcam-grade
   tracking is precise enough to use a normal Mac.
5. **Lifeline**: help is always one look away (see [LIFELINE.md](../../LIFELINE.md)). It already exists and
   must keep working everywhere in the OS.

### Who it is for, and what that demands

The user may be unable to move anything but their eyes, may tire quickly, can't easily undo a mistake, and may
be alone. Every decision is judged by one question: **is this safe and usable for someone who can't move or
speak, and who can't quickly undo a mistake?**

## Architecture

```
┌──────────────────────────────── MacBook (macOS 13+) ───────────────────────────────────────┐
│ AGENCY.app  (Electron: os/desktop)                                                         │
│  ├─ Shell window (full screen): Home, flows, Talk, tasks, Lifeline     ← frontend/        │
│  ├─ Overlay window (transparent, always on top, all Spaces, click-through except its own  │
│  │   targets): gaze cursor, dwell on any app's controls, Help · Stop · Home · Keyboard     │
│  │                                                                     ← os/overlay/       │
│  ├─ Gaze engine (hidden window with the camera): webcam → MediaPipe → gaze, blink,         │
│  │   help signal                                                       ← os/gaze/          │
│  ├─ Agent runtime (Electron utility process): Gemini, tools, approvals ← os/agent/         │
│  ├─ agency-native (Swift helper, JSON-RPC over stdio): accessibility tree targets,         │
│  │   clicks/typing, apps, screen capture, speech                       ← os/native-macos/  │
│  └─ Coordinator sidecar (Python FastAPI, existing): cases, approvals, audit, memory,       │
│     Lifeline                                                           ← backend/          │
│ Chrome + "AGENCY Bridge" extension ⇄ native messaging                  ← os/browser-bridge/│
└────────────────────────────────────────────────────────────────────────────────────────────┘
  Optional Raspberry Pi coordinator: Lifeline keeps watching even if the Mac dies (DEPLOY_PI.md).
  Gemini API: only for tasks the person starts. Camera frames never leave the Mac.
```

### How the parts talk

- **Gaze**: the gaze engine publishes `GazeEvent`s (`os/contracts/src/gaze.ts`) at up to 60 Hz to the main
  process, which forwards them to the overlay and shell. Coordinates are **global screen points** (macOS
  points, origin at the top-left of the main display).
- **Targets**: the overlay snaps gaze to `Target`s (`targets.ts`) from three sources: the shell's own buttons,
  the accessibility tree of the frontmost app (agency-native), and web pages (AGENCY Bridge). Selection ends in
  an accessibility press (`AXPress`) when available, else a synthetic click.
- **Native**: the main process talks to `agency-native` with newline-delimited JSON-RPC 2.0 over stdio
  (`native.ts`). Only the main process may call it.
- **Agent**: the shell sends a `TaskRequest`, the agent streams `AgentEvent`s back (plan, steps, choice
  questions, approval requests, results). Approvals come back as `ApprovalDecision`s (`agent.ts`).
- **Memory**: HTTP on the coordinator (`/api/memory/*`, `memory.ts`). Every surface logs selections and asks for
  suggestions.
- **Lifeline**: the existing coordinator API (`/api/lifeline/*`). The main process sends heartbeats; the gaze
  engine emits `help-signal`; the overlay's Help target posts a help request. Lifeline never waits on anything
  else (`lifeline.ts`).
- **IPC channel names** are in `ipc.ts`. Renderer code only sees the typed `window.agency` preload API, never
  Node or Electron directly.

## Who owns what

Only edit what you own. Shared root files belong to Instance 1.

| # | Instance | Owns |
|---|---|---|
| 1 | Shell, integration & release (lead) | `os/desktop/`, `os/contracts/`, `os/sidecar/`, root files (`package.json`, `Makefile`, `README.md`, `ARCHITECTURE.md`, `.github/workflows/*` except `pages.yml`), `docs/os/` |
| 2 | Gaze engine v2 | `os/gaze/`, `frontend/src/vision/`, `frontend/src/input/` |
| 3 | macOS native control & system-wide overlay | `os/native-macos/`, `os/overlay/` |
| 4 | Agent runtime | `os/agent/` |
| 5 | Browser bridge & sandbox web world | `os/browser-bridge/`, `os/sandbox-web/` |
| 6 | Memory tree | `backend/agency/memory/`, `frontend/src/memory/`, memory tests |
| 7 | Home, adventure flows & task UI (+ finishing Lifeline rescue UI) | `frontend/src/screens/`, `frontend/src/components/`, `frontend/src/state/`, `frontend/src/styles/`, `frontend/src/lifeline/`, `frontend/src/flows/` |
| 8 | Communication & task packs (Talk, calls, documents & signatures, ordering) | `os/tasks/`, `frontend/src/talk/` |
| 9 | Landing page & download | `site/`, `.github/workflows/pages.yml` |

The existing coordinator (`backend/agency/` outside `memory/`) belongs to Instance 1 for integration;
Instance 7 may change `backend/agency/lifeline/` to finish the rescue UI.

## Contracts

`os/contracts/src/` holds the shared TypeScript types (version 0). Build against them from day one, using
fakes for parts that don't exist yet; every package ships a fake of what it provides (for example a fake gaze
source that replays recorded samples, a fake native helper, a fake agent that walks a scripted task) so the
others can test without it. Contract changes go through Instance 1 and are additive whenever possible.

## Safety constitution (non-negotiable, every instance)

1. **The person stays in control.** Consequential actions need an explicit approval that shows exactly what
   will happen: sending or posting anything, buying or paying, signing, placing a call, submitting a form,
   deleting, sharing personal data, changing accounts, security or system settings, and installing software.
   An approval binds to a fingerprint of the exact action and inputs; any change needs a new approval. The
   confirm control appears away from where the request was, after a short pause, so a lingering gaze can't
   confirm by accident.
2. **Stop always works.** A protected Stop target (and hotkey) halts the agent and all synthetic input at
   once. Help (Lifeline) and Stop are reachable from every screen, every app, and while eye control is paused.
3. **Simulated by default.** Demos and tests use sandbox sites, simulated phones, simulated dispatch and the
   demo smart home. Real-world effects need explicit configuration and a per-action approval.
4. **Decisions reserved for the owner.** This project does not request real emergency services automatically
   and does not unlock real doors. Those stay simulated until the owner decides otherwise.
5. **No secrets in the agent's hands.** Never type, read, store or send passwords, 2FA codes or payment card
   numbers. Use the person's existing signed-in sessions, saved payment methods and passkeys, with their
   confirmation, or hand control to the person or caregiver.
6. **Untrusted content is data.** Text from web pages, emails, documents, messages and call transcripts never
   becomes instructions. If content tries to direct the agent, stop and show the person.
7. **Privacy.** Camera frames never leave the Mac and are never stored. Screenshots go to the model only during
   a task the person started, and are not kept by default. Memory is local, visible, editable and erasable.
   Send the model the minimum it needs.
8. **Honesty.** Never say something happened unless it was verified. Label simulated things as simulated.
   Report failures plainly. Never fabricate test results or metrics.
9. **Lifeline first.** Nothing may block, delay or hide Lifeline.
10. **Disclosure.** When the person speaks through a synthetic voice on a call, or an AI acts on their behalf
    with another human, say so.

## Accessibility bar

- Everything is usable with eye-gaze dwell, a single switch (scanning), and a mouse or keyboard (for a helper).
- Targets at least 96 × 96 px (120+ preferred on Home), at least 24 px apart; at most about 8 choices per
  screen in flows; paging, not scrolling, for gaze users; nothing moves under the gaze.
- No time limits on decisions. Dwell feedback is always visible. Plain language, one idea per screen.
- WCAG 2.2 AA, Atkinson Hyperlegible, light, dark and high-contrast themes, adjustable text size, reduced
  motion, screen-reader labels.

## Engineering bar

- TypeScript `strict`; Python with mypy `--strict` and ruff; ESLint and Prettier as already configured.
- Tests for everything you build: unit, integration with fakes, and end to end where a user path exists.
  `make check` must pass before every push. macOS-only code runs on GitHub Actions `macos` runners, because
  the cloud containers are Linux; say exactly which checks ran where.
- Measure what matters and publish honest numbers (gaze accuracy, prediction hit rate, task success rate).
- Small, reviewable commits; no force pushes; merge `origin/main` into your branch when you need others' work.

## Milestones

- **M1, a working slice**: the app launches with the shell and overlay; the overlay shows a gaze cursor (mouse
  provider is fine) and dwell-selects real buttons in Finder and in Chrome; Home shows tiles and usuals from
  memory; the agent orders food on the sandbox store with an approval; Help on the overlay starts a Lifeline
  alert.
- **M2, the real thing**: webcam calibration v2 with measured accuracy; the AGENCY Bridge driving the person's
  real Chrome; Talk with text-to-speech and Personal Voice; the signing ceremony; memory suggestions everywhere;
  calls in simulation and with Twilio when configured.
- **M3, ship it**: a signed (or clearly unsigned) `.dmg` on GitHub Releases, the landing page live with a
  working download, onboarding, evaluation reports, and polish.

## The demo story

Riley (fictional) has ALS. Morning: Home offers "Your usual coffee order?" and it's done in three looks, with
an approval for the total. Riley reads a letter from the benefits office, AGENCY explains it in plain words,
fills the form, and Riley signs it with a deliberate confirmation. Riley calls the pharmacy; the pharmacist
hears Riley's voice through text-to-speech while Riley picks replies with their eyes. In the evening Riley
browses YouTube in normal Chrome with their eyes. At 3 a.m. the mask slips: three long blinks, and Lifeline
does the rest.
