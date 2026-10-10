import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Use the pre-installed Chromium when present (cloud dev boxes); otherwise Playwright's own.
const bundled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM ?? (existsSync(bundled) ? bundled : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    env: { AGENCY_BACKEND_URL: "http://127.0.0.1:8765" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
