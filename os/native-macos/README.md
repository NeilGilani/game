# agency-native

The macOS helper for AGENCY OS. It lets the person's eyes work in every app: it reads the frontmost app's
accessibility tree into gaze targets, presses buttons, clicks, scrolls, types and presses keys, lists and opens
apps, takes in-memory screenshots for the agent, speaks (including Personal Voice) and listens on-device during
calls.

It speaks **newline-delimited JSON-RPC 2.0 over stdio** and implements `NativeMethods` and `NativeEvent` from
[`os/contracts/src/native.ts`](../contracts/src/native.ts). Only the Electron main process talks to it.

```
stdin  → {"jsonrpc":"2.0","id":1,"method":"ax.targets","params":{"maxCount":300}}
stdout ← {"id":1,"jsonrpc":"2.0","result":{"owner":"com.apple.finder","t":1791658820403,"targets":[…],"truncated":false}}
stdout ← {"jsonrpc":"2.0","method":"event","params":{"type":"targets-changed","owner":"com.apple.finder"}}
```

- One JSON object per line in each direction. stdout carries only protocol lines; logs go to stderr.
- Events are notifications with method `"event"` and a `NativeEvent` as params: `frontmost-changed`,
  `targets-changed` (coalesced, 150 ms), `permission-changed` (polled every 2 s), `speech-partial`, `speech-final`.
- The helper exits when stdin closes, after finishing replies already in flight.
- `agency-native --version`, `agency-native --help`.

## Layout

| Path | What |
|---|---|
| `Sources/AgencyNativeCore/` | Platform-independent logic, fully unit-tested: JSON-RPC framing and dispatch, the `NativeServer` rules (permission gating, rate limiting, kill switch, refusals), role mapping, labels, target filtering/clipping/capping, stable ids, the target cache, key codes, typing chunks, capture sizing. |
| `Sources/AgencyNative/` | macOS glue behind the `NativePlatform` protocol: accessibility walker + `AXObserver`, `CGEvent` input, `NSWorkspace` apps, ScreenCaptureKit, AVSpeechSynthesizer, SFSpeechRecognizer. |
| `Sources/AgencyTestApp/` | A tiny AppKit app with known controls (Alpha, Beta, Gamma, a text field, a password field) for integration tests. AppKit, not SwiftUI, because SwiftUI's macros need full Xcode. |
| `Tests/AgencyNativeCoreTests/` | swift-testing suites, plus tests that run the real binary as a subprocess. |
| `fake/fakeNative.ts` | `FakeNative`: an in-memory TypeScript fake of the whole helper for the overlay, agent and shell tests (with `fakeNative.test.ts`). |
| `scripts/` | `test.sh`, `build-universal.sh`, `codesign.sh`. |
| `ci/macos.yml` | Proposed GitHub Actions workflow for Instance 1 to copy into `.github/workflows/`. |
| `Support/Info.plist` | Embedded in the binary (`__TEXT,__info_plist`): bundle id `org.agency.native` and usage descriptions. |

## Methods

| Method | Notes |
|---|---|
| `permissions.status` | All five kinds. Accessibility and Screen Recording can only be `granted` or `denied` (macOS doesn't expose "not asked yet" for them). |
| `permissions.request` | Shows the system prompt (Accessibility opens the prompt pointing at System Settings). Returns the status afterwards. |
| `ax.targets` | Frontmost app: focused window and open menus first, then the menu bar, then other windows. `maxCount` defaults to 300 (max 1000); `includeWeb` (default true) walks into `AXWebArea`s. Targets are clipped to their scroll areas, web areas, windows and displays; disabled and tiny (< 4 pt) ones are dropped. Password fields are `secure: true` and their value is never read into labels. 80 ms walk budget; a cut-short walk sets `truncated`. Cached until an `AXObserver` layout notification or 1 s. |
| `ax.press` | `AXPress`, then `AXConfirm`. Text fields are focused instead (AXPress on a text field can report success without moving focus). Rows and cells are selected. Returns `{ ok: false, error }` when the element is gone or can't be pressed, so the overlay can fall back to a click. |
| `input.click` | Left or right, single or double (`count`), at global screen points. Moves the pointer there first. |
| `input.scroll` | `dx`, `dy` in points; **positive `dy` shows content above** (the CGEvent scroll-wheel convention, as `native.ts` says). At most 5000 per call. |
| `input.drag` | Left button down at `from`, moved to `to` in small steps, released. The button is always released, and Stop releases anything still held. |
| `input.type` | Unicode, in chunks of ≤ 20 UTF-16 units that never split a character; newline and tab are real key presses. **Refuses (`ok: false`) when the focused element is a password field or when focus can't be determined**, re-checking before every chunk. Max 2000 characters. The text is never logged. |
| `input.key` | Key names like `a`, `return`, `escape`, `tab`, `left`, `pagedown`, `f5`; modifiers `cmd ctrl alt shift fn`. **Refuses Command-Q, log out, lock screen (Ctrl-Cmd-Q), force quit (Cmd-Opt-Esc) and Command-Delete variants** with `{ ok: false, error }`: those need the agent's approval or could lock the person out. |
| `apps.list` | Installed apps (`/Applications`, `/System/Applications`, their `Utilities`, `~/Applications`) plus running regular apps, sorted by name; `includeIcons` adds 32 × 32 PNGs (base64). |
| `apps.launch`, `apps.activate`, `apps.frontmost` | As in the contract. There is **no quit**: quitting goes through the agent's approval. |
| `apps.hide` | Hides a running app. Returns `ok: false` when it isn't running. |
| `screen.capture` | ScreenCaptureKit (`SCScreenshotManager`, macOS 14+). Downscaled to `maxWidth` (default 1280, never upscaled), JPEG by default, base64 in memory, **never written to disk**. `scale` = output pixels per screen point: pixel (px, py) is at point (px / scale, py / scale) from the display's top-left. |
| `speech.say` | AVSpeechSynthesizer. `voiceId` from `speech.voices`; `rate` is a multiplier of normal speed (1 = normal, 0.5–2). Returns when speech starts. |
| `speech.voices` | All installed voices, Personal Voices first (`personal: true`). On macOS 14+ the first call asks for Personal Voice access. |
| `speech.listen` | On-device only (`requiresOnDeviceRecognition`); refuses if the language can't be recognised on this Mac rather than sending audio to a server. Results arrive as `speech-partial` / `speech-final` events and are never logged. Recognition restarts across pauses while on. Turning it off always works. |
| `input.stopAll` | The kill switch. Handled on the reader thread the moment the line arrives: never queued, rate-limited or permission-gated. Cancels queued input and typing in progress, stops speech, releases any held mouse button. |

### Rules enforced in code (and tested)

- **Permissions first.** Methods that need a permission fail with JSON-RPC error `-32001` and a plain message
  naming the exact pane, e.g. *"AGENCY needs Accessibility permission to see and press buttons in other apps. A
  helper can turn it on in System Settings > Privacy & Security > Accessibility, next to AGENCY."*
- **Synthetic input** (`ax.press`, `input.*` except `stopAll`) runs in order on one queue, is rate-limited by a
  token bucket (10 burst, 8 per second; error `-32002`), and every queued action is cancelled by `input.stopAll`
  (error `-32003`). Every `CGEvent` carries the tag `0x4147454E4359` ("AGENCY") in `eventSourceUserData`.
- **Never in logs:** typed text, transcripts, labels or values of password fields.
- Other error codes: `-32700` parse error, `-32600` invalid request, `-32601` unknown method, `-32602` invalid
  params, `-32603` internal, `-32004` unsupported, `-32006` not found.

## Build and test

Requires macOS 13+ and Swift 6 (Command Line Tools are enough; Xcode is not required).

```sh
cd os/native-macos
scripts/test.sh                                # debug build + unit tests + protocol tests against the binary
AGENCY_NATIVE_INTEGRATION=1 scripts/test.sh    # also drive AgencyTestApp through the accessibility API
scripts/build-universal.sh                     # release arm64 + x86_64 binary in dist/, prints its path
AGENCY_NATIVE_DEBUG=1 .build/out/Products/Debug/agency-native   # logs walk timings to stderr
```

`scripts/test.sh` passes the swift-testing macro plugin path explicitly: with Command Line Tools only, SwiftPM
sometimes loses it on incremental builds (`plugin for module 'TestingMacros' not found`). The integration test
needs Accessibility permission for the process running it (the terminal locally) and briefly brings a test
window to the front; it presses buttons in that window only and sends no keystrokes.

The TypeScript fake is typechecked and tested from the overlay package (it imports `vitest` and the contracts
by relative path).

## Signing and packaging (for Instance 1)

macOS attributes Accessibility, Screen Recording, camera and microphone permissions to the signed app that
runs the helper, so the helper must be **embedded in AGENCY.app and signed with the same identity**:

1. `bin="$(os/native-macos/scripts/build-universal.sh)"` and copy it into the app, e.g.
   `AGENCY.app/Contents/Resources/bin/agency-native` (or `Contents/MacOS/`).
2. `os/native-macos/scripts/codesign.sh <that path> "Developer ID Application: …"` before signing the app
   bundle. It signs with the hardened runtime and `agency-native.entitlements` (camera, audio input) and
   verifies. Without an identity it signs ad hoc (`-`), which is fine locally but resets permissions on every
   rebuild. No certificates or secrets live in this repo.
3. Spawn it from the main process with stdio pipes; restart with backoff if it exits.

## Verified where

| Check | Where | Result |
|---|---|---|
| `scripts/test.sh` (80 swift-testing tests: core + subprocess protocol test) | Local Mac: Apple silicon, macOS 26.6.2, Swift 6.4 Command Line Tools | Pass (integration test skipped by default) |
| `AGENCY_NATIVE_INTEGRATION=1 scripts/test.sh`: real AX targets from AgencyTestApp, `ax.press` reaches "Beta", password field reported `secure`, typing refused after focusing it | Same Mac, Accessibility granted to the terminal | Pass |
| `ax.targets` on a real app (VS Code, 331 elements walked) | Same Mac | Cold walk ~50 ms (debug and release), cached < 1 ms round trip |
| Universal release build (`lipo`: x86_64 arm64), embedded Info.plist, ad-hoc hardened-runtime signing | Same Mac | Pass |
| `ci/macos.yml` on GitHub Actions | Not run: `.github/workflows` belongs to Instance 1 | Untested |
| `FakeNative` (tsc strict, 10 Vitest tests) | Same Mac, Node 26 | Pass |

**Untested so far:** clicks, scrolling, typing and key presses into real apps (posting events on the developer's
Mac during tests wasn't safe to do unattended); `screen.capture`, `speech.say`, Personal Voice, `speech.listen`
(need a person at the Mac to grant permissions and hear/speak); web content inside Chrome and Safari; the x86_64
slice on Intel hardware; behaviour on macOS 13 and 14.

## Contract requests (for Instance 1)

Additive, recorded here and in the PR:

1. ~~`apps.hide`~~ and ~~`input.drag`~~: added to `native.ts` and implemented here.
2. `input.key` result: add `error?: string` (returned when a combo is refused).
3. Document the semantics chosen above (`input.scroll`'s sign is now in `native.ts`): `speech.say` `rate` as a speed multiplier,
   `screen.capture` `scale` as output pixels per point.
4. Optional JSON-RPC `error.data.permission` (a `PermissionKind`) on `-32001` errors, so the shell can open the
   right onboarding step.
