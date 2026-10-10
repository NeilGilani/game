# Installing AGENCY on a Mac

AGENCY runs on macOS 13 or later. Download the `.dmg` for your Mac from the
[Releases page](https://github.com/NeilGilani/game/releases):

- `AGENCY-<version>-arm64.dmg` for Apple silicon (M1 or later)
- `AGENCY-<version>-x64.dmg` for Intel Macs

Check the download against `SHA256SUMS` on the same page: `shasum -a 256 AGENCY-*.dmg`.

Open the `.dmg` and drag AGENCY to Applications. A helper should do the first start; after that the person can use
AGENCY with their eyes.

## If the build is unsigned

Releases are signed and notarized only when the project's Apple Developer ID is configured. Until then the release
notes say "Unsigned build", and macOS blocks the first start:

1. Open AGENCY from Applications. macOS says it can't check it for malicious software. Choose **Done** (not Move to
   Trash).
2. Open **System Settings → Privacy & Security**, scroll down, and choose **Open Anyway** next to "AGENCY was
   blocked". Confirm with your password or Touch ID.
3. Open AGENCY again.

**Important for unsigned builds:** each update is a different, unsigned app as far as macOS is concerned, so macOS
forgets the **Accessibility** permission (and sometimes Screen Recording) after every update. After updating, open
**System Settings → Privacy & Security → Accessibility**, remove AGENCY with the − button, add it again, and switch
it on. Until then eye control works only inside AGENCY. Help and Stop keep working regardless.

## First start: permissions

AGENCY asks for each permission on its own screen, in plain words, with a button that opens the right System
Settings pane. A helper can use the mouse; the person can finish later by eye, because AGENCY remembers where setup
stopped.

| Permission | Why | Needed? |
|---|---|---|
| Camera | Your eyes move the pointer. The picture never leaves the Mac and is never saved. | Yes |
| Accessibility | Your eyes can press buttons in every app. | Yes |
| Screen Recording | AGENCY can check its work during a task you started. Nothing is kept. | Optional |
| Microphone | Hear the other person on calls. | Optional |
| Speech Recognition | Show what the other person says, on this Mac. | Optional |

## Where AGENCY keeps things

- Data: `~/Library/Application Support/AGENCY`
- Logs: `~/Library/Logs/AGENCY`

## Lifeline: use a Raspberry Pi

If the Mac crashes or runs out of battery, a coordinator on the Mac can't raise the alarm. A Raspberry Pi
coordinator ([DEPLOY_PI.md](../../DEPLOY_PI.md)) notices when the Mac goes quiet and alerts helpers. Set it in
AGENCY's Settings under Coordinator.
