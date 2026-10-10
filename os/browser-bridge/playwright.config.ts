import { defineConfig } from "@playwright/test";

// Extension tests share one Chromium profile per test file and talk to a native host, so they run serially.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  retries: 0,
});
