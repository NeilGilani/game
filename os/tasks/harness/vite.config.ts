/**
 * The Talk test harness: the real Talk screens (frontend/src/talk) and task packs with the
 * PDF engine, simulated backends and a recording speaker, served on their own so they can be
 * tested before the shell routes to them. Not shipped.
 */
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
// npm workspaces hoist packages to the repository root.
const frontendModules = existsSync(`${repo}/frontend/node_modules/react`)
  ? `${repo}/frontend/node_modules`
  : `${repo}/node_modules`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    // One React for the harness and the frontend files it imports.
    alias: [
      { find: /^react$/, replacement: `${frontendModules}/react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${frontendModules}/react/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${frontendModules}/react/jsx-dev-runtime.js` },
      { find: /^react-dom\/client$/, replacement: `${frontendModules}/react-dom/client.js` },
      { find: /^react-dom$/, replacement: `${frontendModules}/react-dom/index.js` },
      { find: /^@fontsource\/(.*)$/, replacement: `${frontendModules}/@fontsource/$1` },
      { find: /^@mediapipe\/(.*)$/, replacement: `${frontendModules}/@mediapipe/$1` },
      { find: /^qrcode-generator$/, replacement: `${frontendModules}/qrcode-generator/qrcode.js` },
    ],
  },
  server: { host: "127.0.0.1", port: 5188, strictPort: true, fs: { allow: [repo] } },
  optimizeDeps: { include: ["pdf-lib", "pdfjs-dist"] },
});
