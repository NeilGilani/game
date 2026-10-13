# Rules for every agent working on AGENCY

AGENCY is a free, eye-controlled computer for people who can only move their eyes (ALS, locked-in syndrome,
brainstem stroke, high spinal cord injury). It was built first for a team member's grandmother, won 1st place at the
UCSC AI Hackathon (Cloud AI track) and is becoming a nonprofit. Team: Neil Gilani, Rayansh "Ray" Bakshi, Ryan Cho.

Read `README.md`, `docs/ROADMAP.md`, `docs/NONPROFIT_PLAN.md` and the README of every package you touch before you
change anything. Read the code before you change it, and match its style.

## Git
- Several agents work at the same time. **Work only on your own branch** (named in your task file), branched from the
  latest `main`. Commit in small, clear steps. Push your branch (`git push -u origin <branch>`). **Never push to
  `main`**, never force-push, never rewrite history. The team merges branches.
- Stay inside your task's area. Edits to shared files (`frontend/src/App.tsx`, `frontend/src/flows/library.ts`,
  `frontend/src/screens/Home.tsx`, `frontend/src/state/agent.tsx`, `frontend/src/state/fakeAgent.ts`,
  `os/desktop/src/main/app.ts`, `os/contracts/src/ipc.ts`, `os/desktop/src/main/settings.ts`, `Makefile`) must be
  small hooks; put your logic in new files.
- Before your last push, merge the latest `origin/main` into your branch and fix any conflicts.

## Quality bar (never skip)
- Run every check for what you touched, and report the real numbers. **Never claim a check passed that you didn't
  run. Never fabricate results.** If something can't be verified here (no Mac, no camera, no real accounts), say so.
  - frontend: `npx tsc -b`, `npx vitest run`, `npx eslint .`, `npx prettier --check src tests e2e`
  - whole app: `make build` (it runs `tsc -b`, which also typechecks tests: frontend tests can't use Node APIs)
  - os packages: `npx tsc --noEmit -p <each tsconfig*.json>`, `npx vitest run`, the package's lint/format scripts
  - backend: `backend/.venv/bin/python -m pytest -q`, `ruff check .`, `mypy agency`
  - site: `npm run typecheck`, `npx vitest run`, `npm run build` (then `git restore site/dist`)
  - Playwright/Electron e2e where your feature has UI. Chromium is at `/opt/pw-browsers/chromium` if you're in the cloud.
- No two files in one folder may differ only in letter case (Macs can't tell them apart; a test enforces it).
- Add tests for everything you build, including the failure paths.

## Safety and privacy (owner rules, non-negotiable)
- Do not put API keys in client-side code. Never print or commit secrets.
- Video is never sent to the cloud by default. Do not collect, upload or retain raw biometric video by default.
- No external real-world messages are sent by default. Anything real (texts, calls, orders, emails, posts) is off
  until a person turns it on, and every single real action needs the person's explicit approval of exactly what
  will happen.
- No automated emergency dispatch (no calls to 911 or similar). No real door unlocking.
- Do not expose secrets or a writable admin API across the local network.
- Do not add unrestricted browser control, shell execution or arbitrary website automation as a shortcut. The
  agent's guard, approvals and Stop always apply.
- Gemini's terms bar users under 18 and use "in clinical practice": don't build features that diagnose, treat or
  replace clinical judgement. AGENCY is not a medical device and must not claim to be.

## Writing
- UI copy and docs: short, warm, plain words. No em dashes. No hype you can't back up.
- Never invent users, quotes, testimonials, statistics or stories. The only real story is one sentence about the
  grandmother.
- People in stock photos are not AGENCY users; never present them as users.

## When you finish
Push your branch, then write a short report in `docs/agent-tasks/reports/<your-branch-name>.md` on your branch:
what you built, how to try it, real test results, what you couldn't verify, and next steps.
