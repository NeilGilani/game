import { defineConfig } from "@playwright/test";

// Electron smoke tests (_electron.launch). They need a display: macOS runners, or xvfb on Linux.
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["list"], ["junit", { outputFile: "test-results/e2e-junit.xml" }]] : [["list"]],
  use: { trace: "retain-on-failure" },
});
