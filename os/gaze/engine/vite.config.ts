import { resolve } from "node:path";
import { defineConfig } from "vite";

// Builds os/gaze/dist/engine.html for AGENCY OS's hidden engine window. The MediaPipe runtime and
// model are served from the app itself (frontend/public, vendored by `make setup`), never a CDN.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  publicDir: resolve(import.meta.dirname, "../../../frontend/public"),
  build: {
    outDir: resolve(import.meta.dirname, "../dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: resolve(import.meta.dirname, "engine.html") },
  },
});
