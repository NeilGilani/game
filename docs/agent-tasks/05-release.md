# Task 5: Install it like a real app

**Branch:** `agent/release`  ·  **Your area:** `.github/workflows/`, `os/desktop` build and packaging config, release
scripts, `docs/os/INSTALL.md`, the site's download page data (not its design)
Read `docs/agent-tasks/RULES.md` first.

## Why
A family should be able to download AGENCY and have it running in ten minutes without a terminal. Today releases have
failed twice (a case-only file name clash on macOS and a test that broke `tsc -b`), the app is unsigned, and there are
no updates.

## Build
1. **Releases that can't break.** Make the release workflow run the same checks as development first (`make build`,
   unit tests) on a macOS runner, plus a smoke test that launches the packaged app and checks it reaches Home. Add a
   CI workflow on pull requests and pushes to main that catches these failures before anyone tags.
2. **Signing and notarization ready.** The workflow already signs when Apple secrets exist. Verify the entitlements
   (camera, Apple events for Messages, accessibility) and hardened runtime, write the exact steps to get an Apple
   Developer ID (nonprofits can get the fee waived: check Apple's current rules and say what's true), and make
   unsigned builds as painless as possible with clear in-app and site instructions.
3. **Updates.** Safe auto-update (electron-updater with GitHub Releases or similar): checks in the background, never
   restarts during use, asks the person or caregiver with one look, verifies signatures/checksums, can roll back.
   Never interrupts a Lifeline alert.
4. **First run that just works.** Everything bundled (Python coordinator, models, MediaPipe files) so nothing needs
   Homebrew, Python or Node on the user's Mac. Check Apple silicon and Intel. macOS permission prompts (camera,
   accessibility, automation) explained step by step on screen, with big "Open System Settings" buttons.
5. **Size and speed.** Measure the download size and cold-start time; cut what you safely can.

## Done means
CI workflow green on a test branch, release workflow verified as far as possible (say exactly what needs a real tag
or Apple secrets), update flow tested with a local fake release feed, install docs a non-technical family can follow.
