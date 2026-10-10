// Builds the main process, the preload script and the built-in pages with Vite into out/.
//   node scripts/build.mjs [--production]
// Renderers owned by other packages (frontend, os/overlay, os/gaze) are built by those packages.
import { cpSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");
const external = ["electron", /^electron\//, /^node:/, ...builtinModules];

const common = {
  root,
  configFile: false,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
};

// Main process: one CommonJS file, Node built-ins and electron external, everything else bundled.
await build({
  ...common,
  build: {
    outDir: "out/main",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    ssr: resolve(root, "src/main/index.ts"),
    rollupOptions: { external, output: { format: "cjs", entryFileNames: "index.cjs" } },
  },
  ssr: { noExternal: true },
});

// Preload: sandboxed, so a single CommonJS file that only requires "electron".
await build({
  ...common,
  build: {
    outDir: "out/preload",
    emptyOutDir: true,
    target: "chrome130",
    minify: false,
    sourcemap: false,
    ssr: resolve(root, "src/preload/index.ts"),
    rollupOptions: {
      external: ["electron"],
      output: { format: "cjs", entryFileNames: "index.cjs", inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true },
});

// Built-in pages: fallback overlay, onboarding, "interface not built".
await build({
  ...common,
  root: resolve(root, "src/renderer"),
  base: "./",
  build: {
    outDir: resolve(root, "out/renderer"),
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: !production,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        overlay: resolve(root, "src/renderer/overlay/index.html"),
        onboarding: resolve(root, "src/renderer/onboarding/index.html"),
        "shell-missing": resolve(root, "src/renderer/shell-missing/index.html"),
        gaze: resolve(root, "src/renderer/gaze/engine.html"),
      },
    },
  },
});

// MediaPipe runtime and face model for the gaze engine, served locally (never from a CDN).
const frontendPublic = resolve(root, "..", "..", "frontend", "public");
for (const dir of ["mediapipe", "models"]) {
  const from = resolve(frontendPublic, dir);
  if (existsSync(from)) cpSync(from, resolve(root, "out", "renderer", dir), { recursive: true });
  else console.warn(`Missing ${from}: run npm run vendor -w frontend (the gaze engine needs it)`);
}

console.log(`Built AGENCY desktop (${production ? "production" : "development"}) into os/desktop/out`);
