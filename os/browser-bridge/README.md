# AGENCY Bridge (Instance 5)

Lets the person and the agent use the person's **own, signed-in Chrome** with their eyes: a Chrome MV3
extension, a native messaging host, and the AGENCY-side client (`BridgeServer`, `BrowserTools`, `FakeBridge`).

## Why an extension (verified 2026-10-10)

- Chrome 136+ ignores `--remote-debugging-port` / `--remote-debugging-pipe` for the default user data
  directory; they now need a non-default `--user-data-dir` ([Chrome blog, 2025-03-17](https://developer.chrome.com/blog/remote-debugging-port)).
  So CDP-based tools can't attach to the person's real, signed-in profile.
- Chrome 137 removed `--load-extension` from branded Chrome ([chromium-extensions PSA, 2025-04](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY)).
  Chromium and Chrome for Testing keep it, which is what our tests use. For the person's Chrome the extension is
  installed once (Load unpacked in developer mode today; a Chrome Web Store listing later, which needs the owner's decision).
- Native messaging: user-level host manifests live in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`;
  `allowed_origins` can't use wildcards; host→Chrome messages ≤ 1 MB, Chrome→host ≤ 64 MiB; an open
  `connectNative` port keeps the service worker alive (Chrome 105+)
  ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [SW lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).

## How it fits together

```
AGENCY main process ── BridgeServer (Unix socket, 0600) ── agency-bridge-host (relay) ── Chrome native messaging ── extension
```
- **Pairing**: `ensurePairing()` writes a 32-byte token to `~/Library/Application Support/AGENCY/bridge/bridge.json` (0600).
  The host proves it knows the token to the app; the extension gets the token once (trust on first use) and
  afterwards refuses a different one until the person presses "Pair with AGENCY again" in the options page.
- **Every message is signed end to end** (HMAC-SHA256 over direction, session nonces and sequence number), so the
  host is only a relay; forged, replayed or reordered commands are dropped (`test/pairing.test.ts`).
- **Install**: `installNativeHost()` writes the launcher and host manifests (Chrome plus other Chromium browsers
  present). The fixed unpacked extension ID is `jabpjflgiailclmdbinljnngohdbdnim`. Dev: `npm run install-host`.

## Tools (`src/protocol.ts`, `src/app/tools.ts`)

Tabs (list, open, activate, navigate); page tree (role, name, value, state, viewport rect, stable `ref`);
click / type / select / scroll by ref; wait for navigation, load, element, text or disappearance; extract text and
tables; capture the visible tab; reading mode; eye-control targets; `stop.all`.

Safety, enforced in the extension:
- **Page content is untrusted**: every read is wrapped `{ untrusted: true, notice, suspectedInjection }`; hidden
  text (display:none, same-colour, tiny, off-screen, aria-hidden) is left out of text and names.
- **Secrets**: password, one-time-code and card fields are `secure`; their values are never read, they can't be typed
  into, and text containing a Luhn-valid card number is never typed. No autofill.
- **Consequential clicks** (buy, send, sign, delete, settings, install, submit...) need `approvedFingerprint` equal to the
  bridge's own fingerprint of the exact page state (`page.describeAction`). Change the page → new fingerprint →
  ask again. `BrowserTools` never takes approvals from the model; only `tools.approve()` after the person decides.
- **Protected sites** (banks, payment apps, password managers, account security, browser pages, extension store):
  refused until the person allows them in an extension window AGENCY can't press (trusted clicks only, "Yes"
  enabled after a pause and placed away from "No"). Allowance lasts until Chrome closes. People can add sites.
- **Visible**: "AGENCY is using this tab" banner with a 180×96 Stop button (also Escape), highlight + label on each
  element before acting. Stop halts everything until the person starts a new task (`session.reset`).

## Eye control on any website

The content script publishes on-screen interactive elements; the service worker converts them to global screen
points (window bounds + toolbar offset from `innerHeight × zoom` + page zoom + pinch zoom) and emits a
`TargetSnapshot` (`source: "web"`, `secure`, AGENCY's Stop as `protected`). Covered elements are left out.

## Verified (all on Neil's MacBook Pro, macOS 26.6.2, Apple silicon, Chrome for Testing 153 via Playwright 1.63)

| What | Result |
|---|---|
| `npm test` (vitest): auth, pairing/protocol with real host + server, policy, injection, geometry, framing, tools, install | 100 passed |
| `e2e/page.spec.ts`: tree, actions, approvals, secrets, injection, tables, waits, Stop, protected sites, reading, capture | 12 passed |
| `e2e/geometry.spec.ts`: targets vs Chrome's own click screen coords, zoom 50–200%, DPR 1 and 2, scrolling, metadata | 15 passed, ≤ 1 pt |
| `PIXEL_CHECK=1` headed: target centres vs real screen pixels (`screencapture`), Retina, zoom 50–200% | 7 passed |
| `e2e/order-usual.spec.ts` with Instance 8's ordering pack (os-8/tasks @ c585d7c via `AGENCY_TASKS_DIR`) | 3 passed |

**Not verified / limits**: the person's real branded Chrome (needs a one-time unpacked install; not done, so the real
NativeMessagingHosts folder was never written); CI on GitHub Actions (no workflow yet; see INTEGRATION_REQUEST.md);
iframes and cross-origin frames aren't read; a side panel on the left would offset targets; one Chrome profile at a time
(newest wins). Injection detection is a heuristic flag, not a guarantee.

Run: `npm install && npm run check && npx playwright test` (uses Chrome for Testing from Playwright's cache).
