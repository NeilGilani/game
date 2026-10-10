# @agency/tasks — task packs (Instance 8)

Talk, calls, documents and signatures, and ordering. Each pack declares its tools, policies,
approvals, verification and an honest real/simulated/untested list (`src/packs/*.ts`), and runs on
`PackRun`, which only executes a consequential tool with a single-use approval grant whose
SHA-256 fingerprint matches the exact tool and arguments (`src/core/runner.ts`).

```
npm install && npm run check      # typecheck, lint, prettier, 95 Vitest tests
npm run harness                   # Talk screens + packs at http://127.0.0.1:5188/#/talk
npm run e2e                       # Playwright on the harness (see "Not run" below)
```

## What is real, simulated, untested

| Area | Real (tested here) | Simulated | Untested / not done |
|---|---|---|---|
| Core | Approval fingerprints, single use, change ⇒ new approval, Stop, audit log | — | — |
| Talk | Core-word board, phrase boards, prediction from history + memory, history, emergency phrases → Lifeline `requestHelp`, conversation-mode reply rules, consent-gated Claude request builder | Speech in tests (fake speaker) | agency-native `speech.say`/Personal Voice and on-device `speech.listen` on a Mac; Claude replies (needs agent) |
| Calls | Emergency/short/premium number refusal, approval of exact number, disclosure spoken first, replies as choices, no card numbers spoken, hang up on Stop, nothing recorded | All calls (scripted pharmacy, clinic, family, voicemail) | Twilio transport (design in `docs/CALLS.md`); agent-assisted calls (stretch, not built) |
| Documents | pdf.js text, pdf-lib fill, typed signature, certificate page (name, time, SHA-256, eye-gaze line, intent), read-back verification, ceremony state machine, refusals (will, POA, notarised, health directive, on-behalf), consent showing exact summary text | Email outbox; summarizer | Import from Downloads/Mail/browser; real email via Bridge |
| Ordering | Usual from memory, items/fees/tip/total review, per-order + daily limits, approval bound to exact terms, re-approval when cart changes, saved payment only, confirmation read-back, tracking | In-memory Thai Basil sandbox store | Instance 5's sandbox site and Bridge adapter |

**Ran where:** all Vitest suites and `make check` on macOS (local, Node 26). **Not run:** the
Playwright specs in `harness/e2e` — the local Playwright headless browser wasn't installed; they
need `npx playwright install chromium-headless-shell` and then `npm run e2e`. Screens were
type-checked but not visually reviewed yet.

E-signature rules vary by place; the certificate page says so.
