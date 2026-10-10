import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// The gaze engine in real Chromium, with Chromium's fake camera playing the web app's test video
// (frontend/e2e/fixtures/.cache/face.y4m: build it with `make e2e-fixtures` at the repo root).
const bundled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM ?? (existsSync(bundled) ? bundled : undefined);
export const FAKE_VIDEO = resolve(import.meta.dirname, "../../frontend/e2e/fixtures/.cache/face.y4m");

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4180",
    // Full Chromium (new headless mode) rather than the headless shell: closer to Electron's GPU path.
    channel: executablePath ? undefined : "chromium",
    launchOptions: {
      executablePath,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${FAKE_VIDEO}`,
        "--ignore-gpu-blocklist",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: {
    command: "npx vite --config bench/browser/vite.config.ts",
    url: "http://127.0.0.1:4180",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
