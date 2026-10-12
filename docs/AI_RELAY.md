# AGENCY Cloud: the AI relay

For the team. Nobody who uses AGENCY should need an API key, so the Mac app's AI runs on our Gemini key through a
relay on the AGENCY site. This page covers how it works, what to set up, what it costs us, and the rules it has to
follow.

## How it works

- **Relay:** Cloudflare Pages Functions in `site/functions/api/relay/v1/` (logic in `site/functions/_lib/relay.ts`),
  in the same `getagencyos` project and on the same `GEMINI_API_KEY` secret as the web demo.
- **Coordinator** (`backend/agency/reasoning/cloud.py`): with no `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`,
  `AgencyCloudProvider` sends each JSON request (plans, replies, sentence endings, explanations) to
  `/api/relay/v1/generate`. The fast lane, failover between the two models, deadlines (10 s minimum), the Synapse
  cache and Synapse routing all work as they do with a local key.
- **Agent** (`os/agent/src/model/cloud.ts`): with no key, `GeminiModel` sends each stateless computer-use turn
  (text, function calls, up to the newest 3 screenshots) to `/api/relay/v1/interactions`.
- **Identity:** on first use the app registers an anonymous install (`POST /api/relay/v1/register`): a random id and
  a secret the relay derives as `HMAC(RELAY_SIGNING_SECRET, id)`. The relay stores nothing to check a signature.
  No account, no personal data. The Mac keeps the install in the keychain (service `AGENCY`, account
  `agency-cloud-install`, shared by the coordinator and the agent); elsewhere it goes in a 0600 file next to the
  database (`AGENCY_CLOUD_IDENTITY_FILE` overrides). The install secret is not a Google key: it only signs requests
  to our relay.
- **Signing:** every request carries `x-agency-install`, `x-agency-time` and
  `x-agency-signature = hex(HMAC-SHA256(secret, "AGENCY-CLOUD-1\nMETHOD\n/path\nunix-time\nsha256-hex(body)"))`.
  The clock may be off by up to 5 minutes. If the clock is further off, the relay sends its time and the app adjusts
  once. If the relay doesn't know the install (for example after the secret was rotated), the app registers again
  once. A fixed test vector is checked in all three code bases.
- **App switches:** `AGENCY_RELAY=off` turns AGENCY Cloud off. `AGENCY_RELAY_URL` points at another relay (default
  `https://getagencyos.pages.dev`). A key of your own (env or keychain `gemini-api-key`) still wins. That's for
  developers. The status bar shows **AI: AGENCY Cloud**.

### Not a general Gemini proxy

- Two request shapes only. Unknown fields are refused at every level that matters.
- Models are allow-listed: `gemini-3.8-flash` and `gemini-3.5-flash-lite` for generate, `gemini-3.8-flash` for the
  agent. `RELAY_GENERATE_MODELS` and `RELAY_AGENT_MODELS` (comma-separated) change the lists.
- **Generate:** the relay builds Google's request itself, with JSON output only, no tools, text only and a
  `BLOCK_MEDIUM_AND_ABOVE` threshold for harassment, hate, sexual and dangerous content forced. Limits: user text
  150 KB, system text 20 KB, schema 30 KB, 32,768 output tokens, a 10–60 s deadline and a 200 KB body.
- **Interactions:** `store: false` and Gemini's prompt-injection detection are forced on. Only `function` and
  `computer_use` tools are allowed, so no Google Search, URL context or code execution. Turns can't use background
  mode, webhooks or `previous_interaction_id`. A turn carries at most 4 screenshots, inline PNG, JPEG or WebP only,
  each under 3 MB of base64. Links to files, audio and video are refused. Limits: 16,384 output tokens and an 8 MB
  body.
- Only the fields the apps read are returned. Google's answer is capped at 2 MB.

## Abuse and cost limits

The relay counts each request against its install, its network and the whole day. Networks are counted under a
keyed hash of the IP address, never the address itself.

| Setting (Pages variable) | Default | What |
|---|---|---|
| `RELAY_ENABLED` | on | `0`/`off` switches AGENCY Cloud off. Apps say "AGENCY's AI is switched off for now" and use built-in plans |
| `RELAY_DAILY_REQUEST_CAP` | 5000 | All requests from everyone per UTC day. Over it: "AGENCY's AI has reached its daily limit, so the built-in plan is used until tomorrow" |
| `RELAY_INSTALL_PER_MINUTE` / `_PER_DAY` | 30 / 600 | Per install. Over the minute limit: "AGENCY's AI is busy. Try again in a minute" |
| `RELAY_IP_PER_MINUTE` / `_PER_DAY` | 60 / 2000 | Per network, so a care home with several Macs still fits |
| `RELAY_REGISTER_PER_IP_DAY` | 10 | New installs per network per day |
| `RELAY_REGISTER_DAILY_CAP` | 2000 | New installs per day, everyone |
| `RELAY_BLOCKED_INSTALLS` | (none) | Comma-separated install ids to refuse |

- A request that is over its own limit is held in memory until its minute or day ends. It doesn't count toward the
  global budget, so one noisy install can't use the day up for everyone.
- **Rough cost at today's prices** (check them: ai.google.dev/gemini-api/docs/pricing): a plan or reply is a
  fraction of a cent. An agent turn with history and 3 screenshots is roughly 1–2 cents on `gemini-3.8-flash`. At
  the default cap, the worst case is on the order of $50–100 a day. Lower the cap at first.
- **Counters:** these use D1 when the `RELAY_DB` binding exists. D1 increments are atomic and the same from every
  Cloudflare location. We chose D1 over KV on purpose. KV allows one write per second per key and its increments
  aren't atomic, so a global counter would undercount under load and the cap could be overshot. KV's free plan also
  allows only 1,000 writes a day. Durable Objects can't be defined inside a Pages project.
  - Without the binding, or if D1 fails, counters fall back to the memory of each Cloudflare isolate. That's best
    effort: the cap then applies per isolate, not in total. Bind D1 before launch.
  - Each request writes about 5 counter rows, so D1's free plan (100k row writes a day) covers about 20k requests
    a day.
- **The real backstop is Google's side:** set a budget alert on the Google Cloud billing account, and a per-day
  request quota for the Generative Language API on the key's project.

## Setup (owner)

1. **Google:** the `GEMINI_API_KEY` must belong to a project with **billing enabled** (the paid tier). On the
   unpaid tier, Google may use prompts and responses to improve its products. On the paid tier it doesn't, and it
   keeps them only for a limited time for abuse monitoring. Set the budget alert and the quota above.
2. **Cloudflare:**
   - `make site-gemini-key`, if it isn't set yet.
   - `make relay-setup`. This generates `RELAY_SIGNING_SECRET` (at least 32 characters; the relay stays off
     without it) straight into Cloudflare, and creates the D1 database `agency-relay`.
   - Bind it in the dashboard: Workers & Pages → `getagencyos` → Settings → Bindings → Add → D1 database, variable
     name `RELAY_DB`, database `agency-relay`. The table creates itself.
   - Optionally set the limits above under Settings → Variables and Secrets.
3. `make site-deploy`. Pages variables, secrets and bindings take effect on the next deployment.
4. Check it: `curl -s -X POST https://getagencyos.pages.dev/api/relay/v1/register -d '{}'` answers an `installId`.
   That uses one of the network's 10 registrations for the day.

**Emergency stop:** set `RELAY_ENABLED=0` and redeploy. For an instant stop, delete or restrict the key in Google
AI Studio; every app then falls back to built-in plans. Rotating `RELAY_SIGNING_SECRET` (rerun the first line of
`make relay-setup`, then deploy) retires every install. Apps register again by themselves.

## Privacy

- The relay never logs or stores request content: no prompts, screenshots or document text. It keeps only
  counters. Its few log lines carry a status code or a reason word. `site/tests/unit/relay.test.ts` checks this,
  including the failure paths.
- Don't turn on Cloudflare Logpush or tail workers that capture request bodies for this project.
- What reaches Google is exactly what a local key would send: the task text and choices for plans, and the agent's
  turns with screenshots of the app it works in. Camera video, face and eye data are never sent.
  `site/src/pages/privacy.astro` says this.

## Terms we must respect

- **Gemini's terms bar users under 18, and clinical use.** AGENCY Cloud must not be offered to minors, and nothing
  built on it may present itself as clinical or medical advice. The Synapse "clinical lens" only asks for calm,
  non-diagnostic wording and hands anything urgent to people. Lifeline is not a medical device. Re-read the current
  Gemini API Additional Terms before launch and when Google updates them.
- Keep the key on the paid tier (above).

## What isn't verified

- The relay has not yet run on Cloudflare with D1. Unit tests use a fake D1 binding.
- Live check, 12 October 2026: one web-demo-style plan (`POST /api/assist/plan`) went through the coordinator app
  and Synapse, then the relay handlers served locally by a small Node harness with the real `GEMINI_API_KEY`, then
  Gemini. `gemini-3.5-flash-lite` answered a valid 4-step plan in about 1.5 s, and the status read AGENCY Cloud,
  ok. The first attempt found a parsing bug, which is fixed and has a regression test.
- The agent's Interactions turn through the relay has only run against a fake Google.
- Safety settings are forced on generate requests only. The agent relies on Gemini's computer-use
  `safety_decision`, its prompt-injection detection and AGENCY's own approvals. Forcing `safety_settings` on
  Interactions turns hasn't been tried live.
