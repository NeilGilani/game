/**
 * "What AGENCY knows about me", end to end: a real coordinator (agency.memory.devserver, SQLite in
 * a temp dir), the real interface and the real input layer. Gaze positions are SYNTHETIC frames
 * injected through the test hook, standing in for calibrated gaze.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Locator, type Page, expect, test } from "@playwright/test";

const BACKEND = "http://127.0.0.1:8766";
const HARNESS = "/e2e/memory/index.html#/memory";
const backendDir = resolve(import.meta.dirname, "..", "..", "..", "backend");
let proc: ChildProcess | null = null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BACKEND}/api/memory${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const DINNER = ["food", "delivery", "Thai Basil", "Pad thai (mild)"];

/** Four past selections at this same weekday and hour, plus a sensitive call and a phrase. */
async function seed() {
  await api("/forget-all", { method: "POST", body: JSON.stringify({ confirm: true }) });
  const now = Date.now();
  for (const weeks of [4, 3, 2, 1]) {
    const at = new Date(now - weeks * 7 * 86_400_000).toISOString();
    await api("/events", {
      method: "POST",
      body: JSON.stringify({
        path: DINNER,
        surface: "food",
        outcome: "chosen",
        at,
        attributes: { restaurant: "Thai Basil", spice: "mild" },
      }),
    });
  }
  await api("/events", {
    method: "POST",
    body: JSON.stringify({ path: ["call", "Pharmacy"], surface: "call", outcome: "chosen" }),
  });
  await api("/events", {
    method: "POST",
    body: JSON.stringify({ path: ["call", "Jordan"], surface: "call", outcome: "chosen" }),
  });
}

test.beforeAll(async () => {
  const db = join(mkdtempSync(join(tmpdir(), "agency-memory-e2e-")), "agency.db");
  proc = spawn(
    join(backendDir, ".venv", "bin", "uvicorn"),
    ["agency.memory.devserver:app", "--host", "127.0.0.1", "--port", "8766"],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        AGENCY_DB_PATH: db,
        AGENCY_REASONING: "deterministic",
        AGENCY_FRONTEND_DIST: "/nonexistent",
      },
      stdio: "ignore",
    },
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BACKEND}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("coordinator did not start");
});

test.afterAll(async () => {
  proc?.kill("SIGTERM");
});

test.beforeEach(async ({ context }) => {
  await seed();
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.testHooks", "1");
    localStorage.setItem(
      "agency.preferences",
      JSON.stringify({ input_mode: "gaze", dwell_ms: 1000, show_gaze_cursor: true }),
    );
  });
});

/** Hold a synthetic gaze point on an element's centre until it is selected. */
async function look(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  await page.evaluate(
    async ({ x, y }) => {
      const hook = (window as unknown as { __agency: { inject: (f: object) => void } }).__agency;
      const end = performance.now() + 1800;
      while (performance.now() < end) {
        hook.inject({ pointer: { x, y }, confidence: 1 });
        await new Promise((r) => setTimeout(r, 33));
      }
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  // Move the gaze away so the next screen's targets aren't selected by a lingering look.
  await page.evaluate(() => {
    const hook = (window as unknown as { __agency: { inject: (f: object) => void } }).__agency;
    hook.inject({ pointer: { x: 2, y: 2 }, confidence: 1 });
  });
  await page.waitForTimeout(900);
}

async function open(page: Page, hash = "") {
  await page.goto(`${HARNESS}${hash}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForTimeout(1500); // refractory after navigation
}

test("the usual Friday-style dinner, with its reason, kept and then forgotten by eye", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "What AGENCY knows about me" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Food/ })).toBeVisible();

  await look(page, page.getByRole("button", { name: /What AGENCY offers first/ }));
  await expect(page).toHaveURL(/#\/memory\/usuals$/);
  const card = page.locator(".mem-usual").filter({ hasText: "Pad thai (mild)" });
  await expect(card).toContainText("Food, then Usual");
  await expect(card).toContainText("Thai Basil, Pad thai (mild)");
  await expect(card).toContainText("Why: You chose this 4 of your last 4");

  await look(page, card.getByRole("button", { name: "Keep" }));
  await expect(card.getByRole("button", { name: "Kept" })).toHaveAttribute("aria-pressed", "true");
  const pinned = (await api<{ label: string; pinned: boolean }[]>("/tree")).find(
    (n) => n.label === "Pad thai (mild)",
  );
  expect(pinned?.pinned).toBe(true);

  await look(page, card.getByRole("button", { name: "Forget" }));
  const sheet = page.getByRole("dialog", { name: /Forget Pad thai/ });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(1200); // the sheet pauses selection briefly
  await look(page, sheet.getByRole("button", { name: "Forget it" }));
  await expect(page.locator(".mem-usual").filter({ hasText: "Pad thai (mild)" })).toHaveCount(0);
  const labels = (await api<{ label: string }[]>("/tree")).map((n) => n.label);
  expect(labels).not.toContain("Pad thai (mild)");
});

test("browsing the tree shows why, and private mode masks sensitive things", async ({ page }) => {
  await open(page);
  await look(page, page.getByRole("button", { name: /^Food/ }));
  await look(page, page.getByRole("button", { name: /^Delivery/ }));
  await expect(page.locator(".mem-usual")).toContainText("Why: You chose this 4 of your last 4");
  await look(page, page.getByRole("button", { name: /^Thai Basil/ }));
  await look(page, page.getByRole("button", { name: /^Pad thai \(mild\)/ }));
  await expect(page.getByRole("region", { name: "What AGENCY knows" })).toContainText("Chosen 4 times");
  await expect(page.getByRole("button", { name: "Forget this" })).toBeVisible();

  await open(page, "/privacy");
  const privateMode = page.getByRole("button", { name: /^Private mode/ });
  await expect(privateMode).toHaveAttribute("aria-pressed", "false");
  await look(page, privateMode);
  await expect(privateMode).toHaveAttribute("aria-pressed", "true");

  await open(page);
  await expect(page.locator(".mem-status")).toContainText("Private mode is on");
  await look(page, page.getByRole("button", { name: /^Call/ }));
  await expect(page.getByRole("button", { name: /^Private/ })).toBeVisible();
  await expect(page.getByText("Pharmacy")).toHaveCount(0);
  const suggestions = await api<{ label: string }[]>("/suggestions?surface=call");
  expect(suggestions.map((s) => s.label)).toEqual(["Jordan"]);
});

test("forget everything asks twice, then the memory is empty", async ({ page }) => {
  await open(page, "/privacy");
  await look(page, page.getByRole("button", { name: /Next/ }));
  await look(page, page.getByRole("button", { name: /^Forget everything/ }));
  const first = page.getByRole("dialog", { name: "Forget everything?" });
  await expect(first).toBeVisible();
  await page.waitForTimeout(1200);
  await look(page, first.getByRole("button", { name: "Yes, forget everything" }));
  const second = page.getByRole("dialog", { name: /Are you sure/ });
  await expect(second).toBeVisible();
  await page.waitForTimeout(1200);
  await look(page, second.getByRole("button", { name: "Forget it all now" }));
  await expect(page.locator("main [role=status]")).toContainText("AGENCY has forgotten everything");
  expect(await api<unknown[]>("/tree")).toEqual([]);
});

test("summaries: nothing is sent while off, and the exact list is shown", async ({ page }) => {
  await open(page, "/summary");
  await expect(page.getByRole("heading", { name: /Exactly what would be sent/ })).toBeVisible();
  await expect(page.locator(".mem-facts")).toContainText("Pad thai (mild): chosen 4 times");
  await expect(page.locator(".mem-facts")).not.toContainText("Pharmacy");
  await expect(page.getByRole("button", { name: /Send this fact/ })).toBeDisabled();
});

test("works with a keyboard alone", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("agency.preferences", JSON.stringify({ input_mode: "pointer", dwell_ms: 1000 })),
  );
  await open(page);
  const usuals = page.getByRole("button", { name: /What AGENCY offers first/ });
  await usuals.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/memory\/usuals$/);
  await page.getByRole("button", { name: "Back" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/memory$/);
});

test("targets are at least 96 px and at least 24 px apart on every explorer screen", async ({ page }) => {
  for (const hash of ["", "/usuals", "/privacy", "/fade", "/summary", "/caregivers"]) {
    await open(page, hash);
    const boxes = await page.locator("main [data-dwell]:visible").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: (el.textContent ?? "").trim().slice(0, 30), x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
    expect(boxes.length, hash).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(Math.min(b.w, b.h), `${hash} ${b.name}`).toBeGreaterThanOrEqual(96);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        expect(Math.max(gapX, gapY), `${hash}: ${a.name} / ${b.name}`).toBeGreaterThanOrEqual(23.5);
      }
    }
  }
});
