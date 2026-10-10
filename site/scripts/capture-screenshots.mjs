// Captures the product screenshots on the landing page from the real AGENCY app, so nothing on the page is a
// mock-up. It starts a real coordinator (FastAPI + SQLite, demo data, built-in plans) that serves the built
// interface, drives it with Playwright, and writes PNGs plus a manifest saying where and when they came from.
//
//   make setup && (cd frontend && npm run build)    # once, from the repository root
//   cd site && npm run screenshots
//
// Re-run it whenever the product changes. AGENCY OS screens (Home, Talk, the overlay) replace these as they land.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..", "..");
const backendDir = join(root, "backend");
const dist = join(root, "frontend", "dist");
const out = resolve(import.meta.dirname, "..", "src", "assets", "screenshots");
const PORT = Number(process.env.SCREENSHOT_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(join(dist, "index.html"))) {
  console.error("Build the interface first: (cd frontend && npm run build)");
  process.exit(1);
}

const db = join(mkdtempSync(join(tmpdir(), "agency-shots-")), "agency.db");
const coordinator = spawn(
  join(backendDir, ".venv", "bin", "uvicorn"),
  ["agency.main:app", "--host", "127.0.0.1", "--port", String(PORT)],
  {
    cwd: backendDir,
    env: {
      ...process.env,
      AGENCY_DB_PATH: db,
      AGENCY_STEP_DELAY_MS: "60",
      AGENCY_REASONING: "deterministic",
      AGENCY_FRONTEND_DIST: dist,
    },
    stdio: "ignore",
  },
);

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function waitForCoordinator() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The coordinator didn't start. Did make setup run?");
}

const shots = [];
async function capture(page, name, alt, theme) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  shots.push({ file: `${name}.png`, alt, theme });
  console.log(`captured ${name}.png`);
}

try {
  await waitForCoordinator();
  await api("/api/demo/reset", { method: "POST" });
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});

  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => localStorage.setItem("agency.onboarded", "1"));
    const page = await context.newPage();
    const suffix = theme === "dark" ? "-dark" : "";

    await page.goto(`${BASE}/#/`);
    await capture(
      page,
      `home${suffix}`,
      "The AGENCY prototype's home screen: Help at the top left, Stop agent at the top right, Lifeline's status, and large choices to start a task.",
      theme,
    );

    await page.goto(`${BASE}/#/new`);
    await capture(
      page,
      `new-task${suffix}`,
      "Starting a task in the prototype: a suggestion for you, then large goal cards such as getting a wheelchair repaired or moving an appointment.",
      theme,
    );

    await page.goto(`${BASE}/#/lifeline`);
    await capture(
      page,
      `lifeline${suffix}`,
      "The prototype's Lifeline screen: Watch over me, the three ways to call for help, and a readiness check.",
      theme,
    );
    await context.close();
  }

  // An approval, from the flagship repair task with built-in plans (no AI key needed).
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => localStorage.setItem("agency.onboarded", "1"));
  const page = await context.newPage();
  await page.goto(`${BASE}/#/new`);
  await page
    .getByRole("button", { name: /wheelchair/i })
    .first()
    .click();
  // Answer any "what's wrong" style question with its first option until the case starts.
  for (let i = 0; i < 4 && !/#\/case\//.test(page.url()); i += 1) {
    const next = page.getByRole("button", { name: /won't charge|battery|start|continue|yes/i }).first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForTimeout(300);
  }
  await page.waitForURL(/#\/case\//, { timeout: 15_000 });
  const approve = page.getByRole("button", { name: /review|approve/i }).first();
  await approve.waitFor({ timeout: 20_000 });
  await approve.click();
  await capture(
    page,
    "approval",
    "An approval in the prototype: exactly what will be booked, when, and for how much, with large Approve, Change, Explain and Say no buttons.",
    "light",
  );

  // The Help countdown: the cancellable first 8 seconds of a Lifeline alert. Cancelled straight after.
  await page.goto(`${BASE}/#/`);
  await page.getByRole("button", { name: /^help/i }).first().click();
  await page.getByRole("alertdialog").waitFor();
  await capture(
    page,
    "help-countdown",
    "Lifeline's 8-second countdown after asking for help. Cancel needs a longer look; Call now skips the wait.",
    "light",
  );
  await api("/api/demo/reset", { method: "POST" });
  await context.close();
  await browser.close();

  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(
      {
        source:
          "The AGENCY web prototype in this repository (frontend/), served by a real coordinator with demo data.",
        commit,
        captured: new Date().toISOString().slice(0, 10),
        viewport: "1280x800 at 2x",
        shots,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`manifest.json written (commit ${commit})`);
} finally {
  coordinator.kill("SIGTERM");
}
