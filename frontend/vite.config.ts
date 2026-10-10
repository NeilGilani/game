/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The coordinator (FastAPI) runs on this MacBook by default. To use a Raspberry Pi
// coordinator, start Vite with AGENCY_BACKEND_URL=http://<pi-address>:8000 so the browser
// keeps talking to localhost (a secure context, required for the camera) and Vite forwards
// /api to the Pi. /respond is the page Lifeline contacts open from their alert message.
const backend = process.env.AGENCY_BACKEND_URL ?? "http://127.0.0.1:8000";
const proxy = {
  "/api": { target: backend, changeOrigin: true },
  "/respond": { target: backend, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy,
  },
  build: { target: "es2022", sourcemap: true },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
