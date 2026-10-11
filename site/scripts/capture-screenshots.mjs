// Captures the product screenshots on the landing page from the real AGENCY app, so nothing on the page is a
// mock-up. It starts a real coordinator (FastAPI + SQLite, demo data, built-in plans) that serves the built
// interface, drives it with Playwright, and writes PNGs plus a manifest saying where and when they came from.
//
//   make setup && (cd frontend && npm run build)    # once, from the repository root
//   cd site && npm run screenshots
//
// Re-run it whenever the product changes.
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
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(out, `${name}.png`) });
  shots.push({ file: `${name}.png`, alt, theme });
  console.log(`captured ${name}.png`);
}

const ALT = {
  home: "AGENCY's Home on its Mac-style desktop: twelve big app tiles such as Talk, Call someone, Food and Lifeline, your usuals on the left, and a dock with Help, Home, Talk, Keyboard and Stop agent.",
  approval:
    "A task waiting for approval: the plan with two of four steps done, and exactly what will be paid, to whom and for what, with large Approve, Change and Decline buttons. Marked simulated.",
  talk: "Talk: big word buttons build a sentence to speak out loud, with tabs for Phrases, Listen, History, Voice and Emergency.",
  lifeline:
    "Lifeline: Watch over me, the three ways to call for help without speaking or moving, and whether Lifeline is ready.",
  "help-countdown":
    "Lifeline's 8-second countdown after asking for help: AGENCY will alert Jordan unless you cancel. Cancel needs a longer look; Call now skips the wait.",
};

/** A browser context like the one the design review uses: onboarded, demo agent, chosen theme. */
async function newPage(browser, theme) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript((t) => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem("agency.fakeAgentDelayMs", "100");
    localStorage.setItem("agency.preferences", JSON.stringify({ theme: t }));
  }, theme);
  return { context, page: await context.newPage() };
}

try {
  await waitForCoordinator();
  await api("/api/demo/reset", { method: "POST" });
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});

  for (const theme of ["light", "dark"]) {
    const { context, page } = await newPage(browser, theme);
    const suffix = theme === "dark" ? "-dark" : "";

    await page.goto(`${BASE}/#/`);
    await page.getByRole("button", { name: /Help: call for help/ }).waitFor();
    await capture(page, `home${suffix}`, ALT.home, theme);

    await page.goto(`${BASE}/#/talk`);
    await capture(page, `talk${suffix}`, ALT.talk, theme);

    await page.goto(`${BASE}/#/lifeline`);
    await capture(page, `lifeline${suffix}`, ALT.lifeline, theme);

    // A task waiting for approval: the usual food order, planned by the built-in demo agent.
    await page.goto(`${BASE}/#/flow/food`);
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: /^Your usual/ }).click();
    await page.getByTestId("approval").waitFor({ timeout: 20_000 });
    await capture(page, `approval${suffix}`, ALT.approval, theme);
    await page
      .getByRole("button", { name: /^Decline/ })
      .first()
      .click()
      .catch(() => {});

    // The Help countdown: the cancellable first 8 seconds of a Lifeline alert. Cancelled straight after.
    if (theme === "light") {
      await page.goto(`${BASE}/#/`);
      await page.getByRole("button", { name: /Help: call for help/ }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, "help-countdown.png") });
      shots.push({ file: "help-countdown.png", alt: ALT["help-countdown"], theme });
      console.log("captured help-countdown.png");
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: /Cancel, I'm OK/ })
        .click()
        .catch(() => {});
    }
    await api("/api/demo/reset", { method: "POST" });
    await context.close();
  }
  await browser.close();

  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(
      {
        source:
          "The AGENCY app in this repository (frontend/), served by a real coordinator with demo data and the built-in demo agent.",
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
