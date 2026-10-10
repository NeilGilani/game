import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const bundled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM ?? (existsSync(bundled) ? bundled : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "../test-results",
  use: {
    baseURL: "http://127.0.0.1:5188",
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --config harness/vite.config.ts",
    cwd: "..",
    url: "http://127.0.0.1:5188",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
