import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Use the pre-installed Chromium when present (cloud dev boxes); otherwise Playwright's own.
const bundled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM ?? (existsSync(bundled) ? bundled : undefined);
// Other ports let several checkouts run end-to-end tests at once.
const port = process.env.AGENCY_E2E_PORT ?? "4173";
const backendPort = process.env.AGENCY_E2E_BACKEND_PORT ?? "8765";

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    env: { AGENCY_BACKEND_URL: `http://127.0.0.1:${backendPort}` },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
