/** Serves the memory harness page (e2e/memory/index.html) with the app's sources. */
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const frontend = resolve(import.meta.dirname, "..", "..");
const backend = process.env.AGENCY_BACKEND_URL ?? "http://127.0.0.1:8766";

export default defineConfig({
  root: frontend,
  plugins: [react()],
  publicDir: resolve(frontend, "public"),
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: { "/api": { target: backend, changeOrigin: true } },
    open: false,
  },
});
