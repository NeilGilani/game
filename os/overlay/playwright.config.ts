import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Use the pre-installed Chromium when present (cloud dev boxes); otherwise Playwright's own.
const bundled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM ?? (existsSync(bundled) ? bundled : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4183",
    viewport: { width: 1470, height: 956 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npx vite preview --port 4183 --strictPort",
    url: "http://127.0.0.1:4183",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
