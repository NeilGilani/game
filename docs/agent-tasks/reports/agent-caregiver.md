# Report: agent/caregiver (Task 3, the caregiver's phone companion)

## What I built

A carer pairs their phone by scanning a QR code on the person's screen, then uses a phone web page (no app store)
served by the coordinator on the home Wi-Fi. Setup guide: [docs/CAREGIVER_COMPANION.md](../../CAREGIVER_COMPANION.md).

**Pairing and security** (`backend/agency/companion/`)
- A second, small server (`server.py`, port 8470) runs inside the coordinator **only while a helper turns caregiver
  phones on** at the Mac. It has no route into `/api`. It serves the phone page, its own API (`/phone/api`) and
  Lifeline's existing response pages (`/respond/{token}`).
- Six-digit pairing code in the QR link (after `#`, so it's never sent in an address): 5 minutes, works once, cancelled
  after 5 wrong tries, a new code retires the old one.
- A key per phone, stored hashed (SHA-256), revocable from the Mac; a phone can also unpair itself. Turning caregiver
  phones off stops the server.
- Refuses addresses outside private home ranges (so a router port-forward can't expose it) and Host headers that
  aren't an IP, `localhost`, `.local` or the configured address (DNS rebinding). Rate limits on pairing (per address
  and overall), messages, notes and all requests; 2 MB body limit; strict headers and CSP; no CORS.
- Optional HTTPS with your own certificate (`AGENCY_COMPANION_TLS_CERT`/`_KEY`); plain HTTP on the home network by
  default, stated plainly on the Mac screen and in the guide.

**Set up from the phone** (contacts, details for forms, Talk phrases, favourite sites, the Papers folder, safety)
- Contacts and safety settings live on the coordinator (Lifeline's settings) and change there.
- Details, phrases, favourite sites and the Papers folder live on the Mac: the person's screen picks them up, applies
  them (`frontend/src/companion/apply.ts`) and reports back. Phrases go on their own Talk board, "From your carers".
- **Carers suggest, the person decides**: adding or changing a real phone number, removing a contact, or turning any
  protection off (or making it slower) waits until the person looks at **Allow** on their screen. Everything else
  applies at once. Every change shows on the person's screen and is read aloud with who made it, and is listed under
  Settings, For a helper, Caregiver phones, "Who changed what".
- Details for forms are erased from the coordinator once the Mac has saved them.

**Stay close**
- Phone Home: an open alert (with **Open the alert** once Lifeline has asked this phone's person, which opens the same
  response page an alert text links to), "AGENCY is running", camera, the Mac's battery, Watch over me and check-ins,
  recent alerts. A new alert buzzes and beeps while the page is open.
- A short message and/or photo (shrunk on the phone) appears big on the person's screen until they look at **Got it**;
  the phone sees when it was seen. Lifeline's emergency screen and check-ins always come first.

**Hand-over notes** stored on the Mac, readable and writable from every paired phone and from the Mac.

**Design**: Atkinson Hyperlegible at 20 px, 56 to 72 px targets, the four places in a bottom bar in reach of a thumb,
strong contrast in light and dark.

### Files
- New: `backend/agency/companion/*`, `backend/tests/test_companion.py`, `frontend/companion.html`,
  `frontend/src/companion/**`, `frontend/tests/companion.test.ts`, `frontend/e2e/companion.spec.ts`,
  `docs/CAREGIVER_COMPANION.md`.
- Small hooks in shared files: `backend/agency/main.py` (create/stop the companion, one router, one error handler),
  `backend/agency/db.py` (**migration 6**), `frontend/src/App.tsx` (one route, one layer),
  `frontend/src/screens/OsSettings.tsx` (one tile under For a helper), `frontend/vite.config.ts` (second entry),
  `frontend/e2e/backend.ts` (optional env per spec), `os/desktop/src/main/processes.ts` and `app.ts` (pass
  `AGENCY_COMPANION_DIST` to the bundled coordinator, which otherwise serves no interface), README and ARCHITECTURE
  pointers.

## How to try it

```sh
make setup && make demo        # http://localhost:8000
```
At the Mac: Settings, For a helper, **Caregiver phones**, turn it on, **Show a pairing code**. On a phone on the same
Wi-Fi, scan the QR code (or open the address shown and type the code). Allow incoming connections if macOS asks.

## Test results (all run on this branch, on a Mac, 12 October 2026)

| Check | Result |
|---|---|
| `make check` (ruff, ruff format, mypy, ESLint, Prettier, tsc, all unit tests, build, OS packages) | Passed |
| Backend `pytest` | 314 passed (64 new in `test_companion.py`) |
| Frontend Vitest | 221 passed (14 new) |
| `@agency/desktop` unit tests | 142 passed |
| `e2e/companion.spec.ts` (Playwright, 390×844 touch viewport, real coordinator and phone server) | 5 passed: pairing through the QR link and setup with the person allowing a real number; message + photo + notes; a Lifeline alert answered on the real response page; security (unpaired, wrong code, removed phone, bursts, server off); axe WCAG 2.2 A/AA with zero violations on all 12 phone screens (pairing and "Paired" in light; the other 10 in light and dark) and on the Mac screen |
| Full Playwright suite | 68 passed, 1 failed, 3 skipped. The failure, `gaze-ai.spec.ts` "sharp tracking: the same gaze goes to the nearer button", **fails the same way on an unmodified `origin/main` checkout** on this Mac, so it isn't from this branch |

Playwright ran with Chrome for Testing 1243 (`PW_CHROMIUM=...`), because the Chromium build the repo's Playwright
expects wasn't fully installed on this Mac. Another session was running Playwright on the same fixed ports
(8765/4173) during part of this work; the numbers above come from runs where the ports were free.

The tests found and I fixed: the camera state is `running` (not `on`); the Mac announced a change before it was
applied; new contacts lost their ids between saves; a second pairing link on an open page was ignored; "trys"; the
phone said "Riley says: not said yet"; and the Mac app's coordinator would not have served the phone page at all.

## What I couldn't verify

- Real iPhones and Android phones on a real home Wi-Fi (tests use Chromium at phone size on the same computer).
- HTTPS with a real certificate on a phone, the macOS firewall prompt, and the packaged Mac app (the hook passing
  `AGENCY_COMPANION_DIST` typechecks and the desktop unit tests pass, but the app wasn't built and run).
- Reading the screen in bright sunlight (colours chosen for strong contrast, not measured outdoors).
- Alerts on a closed or locked phone page: phone browsers suspend background pages, and push needs an internet push
  service AGENCY doesn't use, so the companion is in addition to Lifeline's texts and calls, as the guide says.

## Notes for the team

- **Migration 6** is in `db.py`. If another branch also adds a migration 6, renumber one when merging.
- Talk phrases are written to Talk's storage key (`agency.talk.boards`) from `frontend/src/companion/apply.ts`. If
  `agent/talk` changes that format, update `readBoards`/`withCarersPhrases` there. An open Talk screen shows new
  phrases the next time it opens (Talk's storage hook has no outside "changed" signal).
- The phone server mounts the whole built `assets/` folder (static code, no data); it never serves `index.html`.

## Next steps

1. Try it with real carers on real phones (iPhone Safari, Android Chrome), on the person's own Wi-Fi.
2. Make HTTPS easy: a one-tap way to create and trust a local certificate, or pin a self-made one with a fingerprint
   check in the QR code.
3. Optional push notifications through a relay the family chooses, so alerts reach a locked phone (needs HTTPS and a
   careful privacy review).
4. Let the person choose which carers may change what (per-carer permissions), and add a "what changed this week"
   summary they can have read aloud.
5. Add the Mac's Caregiver phones screen to the shared `axe.spec.ts` and `screens.spec.ts` lists.
