# Task 8: Connection and joy

**Branch:** `agent/connection`  ·  **Your area:** new modules (e.g. `frontend/src/joy/`) and small hooks into Home
Read `docs/agent-tasks/RULES.md` first.

## Why
People with ALS often say the hardest part isn't the body, it's being cut off: from family, from books, from music,
from being themselves. AGENCY should bring those back, by eye, without needing anyone's help.

## Build
1. **Video calls by eye.** Start a FaceTime (or other) call to a saved person in two looks, with the Talk board beside
   the call and a big "end call". Reuse the real-messaging contacts and approval rules in
   `frontend/src/state/realMessaging.ts` and `os/desktop/src/main/messaging.ts`; never call anyone not saved; off by
   default.
2. **Books.** A reader for free public-domain books (Project Gutenberg / Standard Ebooks; check their terms) and the
   person's own EPUB/PDF files: big type, page turns by look, read aloud with the person's chosen voice, bookmarks,
   and "look at a word to hear it / define it" on device.
3. **Photos and memories.** A slideshow and album browser for a folder of photos the family fills (local only), with
   "tell me about this photo" captions the family can add, and one-look reactions the person can send back later.
4. **Music and radio.** Play the person's music (Apple Music via the Music app, with the existing apps pack) and free
   internet radio, big Play/Skip/Volume, "play something calm/upbeat".
5. **Make things.** An eye-drawing canvas (dwell to place, smoothing, big colour wells, undo) and a simple journal the
   person writes with the eye keyboard, private by default.
6. Everything works in the browser version too where possible (practice data where not).

## Done means
Each feature working with tests (unit + e2e), accessible by eye only (verify every control is a dwell target of at
least the app's minimum size), screenshots of each screen in your report, nothing real by default.
