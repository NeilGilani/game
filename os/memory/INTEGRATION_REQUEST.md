# Memory tree (Instance 6): integration requests

Everything below is outside Instance 6's area, so it is requested here rather than done.

## For Instance 1 (shell, integration, contracts)

1. **Mount the router** in `backend/agency/main.py`, next to the Lifeline routers:

   ```python
   from .memory import memory_router
   ...
   app.include_router(memory_router())
   ```

   Until then, `agency.memory.devserver:app` is the coordinator with the router mounted (used by the memory
   end-to-end tests).

2. **CORS methods**: `os/contracts/src/memory.ts` uses `PATCH /nodes/{id}` and `DELETE /nodes/{id}`, but
   `main.py` allows only `GET, POST, PUT`. Add `PATCH` and `DELETE` to `allow_methods` (it only matters for
   cross-origin callers; the Vite proxy and the coordinator-served UI are same-origin).

3. **Route the explorer** in `frontend/src/App.tsx`, and add a Nav entry ("What AGENCY knows"):

   ```tsx
   import { MemoryExplorer } from "./memory";
   ...
   if (a === "memory") return <MemoryExplorer segments={route.segments.slice(1)} />;
   ```

   After that, the memory end-to-end tests can move from the harness page (`e2e/memory/index.html`) to
   `/#/memory` in the real shell.

4. **Migration number**: memory uses **migration 5** in `backend/agency/db.py`. If another instance also
   claimed 5, renumber whichever merges second. Two existing tests hard-coded schema version 4; they now read
   `MIGRATIONS[-1][0]` so new migrations don't break them (`tests/test_engine_rules.py`,
   `tests/test_api_and_provider.py`).

5. **Contract additions** (all additive, for `os/contracts/src/memory.ts`):
   * `POST /forget-all` requires the body `{ "confirm": true }`. An accidental empty request is refused
     (422), because erasing everything can't be undone.
   * `PATCH /nodes/{id}` also accepts `sensitive?: boolean`.
   * `GET /suggestions` accepts `prefix` (keyboard words and phrases); `GET /usual` also accepts repeated
     `p=` parameters for names that contain `/`.
   * Tree nodes also carry `effectiveSensitive`, `effectiveHidden` and, in private mode, `masked: true`
     (label "Private", no details).
   * New endpoints: `GET /nodes/{id}` (detail with reason and counts), `GET /overview`,
     `GET|PUT /settings`, `GET|PUT /encryption`, `POST /onboarding` (cold start), `POST /prefill`
     (pre-select an answer to a `ChoiceQuestion`), `GET /summary/preview`, `POST /summary`, `GET /notes`,
     `DELETE /notes/{id}`, `GET|POST /grants`, `DELETE /grants/{id}`, `GET /caregiver` (header
     `X-Memory-Grant`). The TypeScript shapes are in `frontend/src/memory/types.ts`.

6. **Optional dependency for encryption at rest**: `cryptography` (AES-256-GCM). It isn't in
   `backend/requirements.txt`, so turning encryption on currently fails with a plain message instead of
   storing plaintext. Please decide whether to add it (it ships wheels for macOS and the Raspberry Pi), or
   whether you prefer whole-database encryption (SQLCipher) instead.

7. **CI**: there is no `.github/workflows/` yet. When there is, please run:
   * on a **macos** runner: `pytest tests/test_memory_privacy.py` (the real-keychain test creates and
     deletes a throwaway keychain file; it is skipped on Linux),
   * `npx playwright test -c e2e/memory/playwright.config.ts` from `frontend/` (memory end-to-end tests,
     not matched by the main Playwright config).

## For Instance 3 (native macOS)

The memory key lives in the keychain (service "AGENCY Memory", account "memory-key"). Today
`KeychainKeyStore` uses `/usr/bin/security`, which puts a new key on that command's arguments once,
when the key is created. If `agency-native` gains a `keychain.get/set` method using Security.framework,
memory can switch to it.

## For Instance 4 (agent runtime)

* Before showing a `ChoiceQuestion`, call `POST /api/memory/prefill` with
  `{ path: ["food", "delivery"], question }`. When it returns an option, put its `reason` in that option's
  `suggestedBecause` and show it first. It never answers for the person; it returns `null` unless the
  choice is settled (at least 3 of the last 5, with 4 or more occasions in that context).
* After the person answers, log it: `POST /api/memory/events` with the task's path, `outcome: "chosen"` and
  `attributes: { <field>: <option label> }`.
* Suggestions carry `task: { goal, selections }` for starting a `TaskRequest` with `origin:
  "memory-suggestion"`.

## For Instances 7 and 8 (Home, flows, Talk)

From `frontend/src/memory`:

* `logSelection(event)` after every choice, with `outcome: "chosen"`, then `"completed"` when the task
  is done, or `"rejected"` when the person passes over a suggestion. It never throws.
* `useSuggestions(surface, limit)` for Home, food, call, Talk, keyboard (`prefix`), papers, shopping,
  apps and browse.
* `<UsualCard suggestion={...} />` renders "Food, then Usual Friday dinner: Thai Basil, Pad thai (mild).
  Why: ... Keep / Forget".
* `FakeMemoryApi` is an in-memory stand-in for tests (`new FakeMemoryApi(() => fixedDate)`, `.seed([...])`).
