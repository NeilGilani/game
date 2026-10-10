/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The overlay is loaded by Instance 1's transparent overlay window (os/desktop). In a plain browser
// (npm run dev, Playwright) it runs against the fake host: mouse = gaze, scripted targets, fake native.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5183, strictPort: true, fs: { allow: [repoRoot] } },
  preview: { host: "127.0.0.1", port: 4183, strictPort: true },
  build: { target: "es2022", sourcemap: true },
  test: {
    include: ["tests/**/*.test.ts", "../native-macos/fake/**/*.test.ts"],
    environment: "node",
  },
});
