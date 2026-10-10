import { resolve } from "node:path";
import { defineConfig } from "vite";

// Serves the benchmark page with the web app's vendored MediaPipe runtime and model
// (frontend/public/mediapipe, frontend/public/models: run `npm run vendor` in frontend first).
export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(import.meta.dirname, "../../../../frontend/public"),
  server: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, "../..")] },
  },
});
