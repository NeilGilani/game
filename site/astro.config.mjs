// @ts-check
import { defineConfig } from "astro/config";

// GitHub Pages serves a project site at https://<owner>.github.io/<repo>/, so the base path defaults to
// "/game/". Vercel, Netlify or a custom domain serve from the root: set SITE_BASE=/ (see README.md).
const base = process.env.SITE_BASE ?? "/game/";
const site = process.env.SITE_URL ?? "https://neilgilani.github.io";

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  output: "static",
  build: { inlineStylesheets: "always", format: "directory" },
  // No prefetching, no analytics, no third-party integrations: the page loads only its own files.
  prefetch: false,
  devToolbar: { enabled: false },
});
