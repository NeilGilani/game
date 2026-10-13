# Task 2: Talk faster, sound like yourself

**Branch:** `agent/talk`  ·  **Your area:** `frontend/src/talk/` and new files it needs
Read `docs/agent-tasks/RULES.md` first.

## Why
Talking is the most important thing AGENCY does. People using eye-gaze communication often manage only a handful of
words a minute, so conversations move on without them. Every saved look matters, and so does sounding like yourself.

## Build
1. **Measure first.** A benchmark of looks (selections) per word and seconds per sentence for a fixed set of everyday
   sentences, using the Talk board as it is today. Record the baseline.
2. **Prediction that learns the person.** Word and phrase prediction that learns from what the person says (stored
   only on their computer, with a "forget" control), uses context (time of day, who they're talking to, what was
   just said in Listen mode), and keeps the most likely next words in the same places so the eyes learn them. Use
   on-device prediction first; the cloud (through the existing Synapse/relay path) only to suggest whole replies,
   and only when allowed in Settings.
3. **Quick fire.** One-look core phrases that matter most ("yes", "no", "wait", "I'm uncomfortable", "suction",
   "reposition me", "I love you"), editable by the person and caregiver, and a partner-assisted "spell it, you guess
   it" mode for partners who read along.
4. **Your own voice.** Use macOS Personal Voice when the person has made one (check what Electron/Swift can access;
   the native helper is in `os/native-macos`), with clear setup steps for banking a voice while speech remains.
   Fallback: the best system voice, with speed and pitch controls.
5. **Conversation flow.** Speak-as-you-type option, "I'm typing, please wait" signal shown on screen or spoken, quick
   repair ("I mean…", "no, the other one"), and history of what was said today to repeat with one look.

## Done means
Benchmark shows fewer looks per word (report before/after), all new features tested, Personal Voice path built and
honestly documented (what's verified and what needs a Mac), no regressions in Talk e2e tests.
