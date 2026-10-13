# Task 3: The caregiver's phone companion

**Branch:** `agent/caregiver`  ·  **Your area:** a new `companion/` (or `frontend/src/companion/`) plus the minimum
backend endpoints in new backend modules
Read `docs/agent-tasks/RULES.md` first.

## Why
The person using AGENCY can't set it up alone. Today a helper has to sit at the Mac and type contacts, details, a
signature, a Papers folder and settings with a keyboard. Families and paid carers are busy and often elsewhere.

## Build
1. **Pair a phone in one look.** AGENCY shows a QR code; the caregiver scans it and gets a mobile web companion
   (no app store) over the local network, paired with a short-lived code. Security: per-device tokens, revocable from
   the Mac, HTTPS or an equivalent protected channel if you can make it work locally, rate limits, nothing writable
   without pairing, never exposed beyond the home network by default (owner rule: no writable admin API across the
   network without protection). Read how the backend handles `AGENCY_API_TOKEN`, origins and the Lifeline responder
   pages first and reuse what fits.
2. **Set up from the phone.** Contacts (for Lifeline, calls and texts), the person's saved details for forms, phrase
   lists for Talk, favourite sites for the browser, the Papers folder choice, and safety settings. Every change shows
   on the Mac, and the person can see who changed what.
3. **Stay close.** The companion receives Lifeline alerts and check-ins the person sends (reuse Lifeline's channels
   and responder flow), shows "AGENCY is running, camera OK, battery OK", and lets the caregiver send a short message
   or photo that appears big on the person's screen. Nothing reaches the person's screen without the pairing.
4. **Hand-over notes.** A simple shared log where carers leave notes for the next shift (stored on the Mac).
5. Design: excellent on a phone, one hand, plain words, big type, works in bright light.

## Done means
Pairing, setup, alerts and notes working end to end in tests (Playwright on a phone-size viewport against the real
backend), security tests (unpaired access refused, revoked device refused, rate limits), and a clear setup guide.
