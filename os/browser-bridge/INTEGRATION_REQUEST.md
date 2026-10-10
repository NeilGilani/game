# Integration requests from Instance 5

## For Instance 1 (contracts, desktop, CI)
1. **Contracts**: add the bridge protocol (or re-export `os/browser-bridge/src/protocol.ts`) to `os/contracts`, and
   optionally `Target.restricted?: boolean` so web targets from protected sites are never sent to the model.
2. **Desktop main process**: at first run call `ensurePairing()` and `installNativeHost({ configPath, hostScript:
   <resources>/host.cjs, runtime: process.execPath, runAsNode: true })`; start `BridgeServer`; forward
   `targets` events into the overlay's merged `TargetSnapshot` (only while Chrome is frontmost); send `stop.all` on the
   global Stop, and handle the `stopped` event (person pressed Stop in Chrome) as a global Stop. Show the pairing code
   (`tokenFingerprint`) in Settings.
3. **CI**: a macOS job: `cd os/sandbox-web && npm ci && npm test`, `cd os/browser-bridge && npm ci && npm run check &&
   npx playwright install chromium && npx playwright test` (headless). Add both packages to `make check`.

## For Instance 4 (agent)
Use `BrowserTools` (definitions + executor). On `needs-approval`, emit `approval.required` with the given
`ApprovalRequest`; call `tools.approve(fingerprint)` only after the person's `approve`. Treat non-empty
`suspectedInjection` as "stop and show the person". `FakeBridge` covers tests without Chrome.

## For Instance 8 (ordering)
`DashDishBridgeStore` (`src/stores/dashdish.ts`) implements your `StoreClient` on the sandbox store through the bridge;
`e2e/order-usual.spec.ts` runs your pack against it. Requests: (a) a `simulated` flag separate from `kind`, since a
store can be both "bridge" and sandbox; (b) optionally let `placeOrder` receive the bridge's action fingerprint so your
approval and the bridge's bind to the same page state.
