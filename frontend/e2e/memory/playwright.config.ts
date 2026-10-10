/**
 * Memory explorer end-to-end tests (Instance 6). Run from frontend/:
 *   npx playwright test -c e2e/memory/playwright.config.ts
 * Uses the harness page and agency.memory.devserver until the shell routes #/memory.
 */
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const bundled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM ?? (existsSync(bundled) ? bundled : undefined);

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --config e2e/memory/vite.config.ts",
    cwd: "../..",
    url: "http://127.0.0.1:4174/e2e/memory/index.html",
    env: { AGENCY_BACKEND_URL: "http://127.0.0.1:8766" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
