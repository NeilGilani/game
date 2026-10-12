// Checks every internal link and #anchor in the built site, offline. External links are checked separately in CI
// with lychee (.github/workflows/pages.yml), because they depend on other people's servers.
// Usage: node scripts/check-links.mjs dist
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");
const base = (process.env.SITE_BASE ?? "/game/").replace(/\/?$/, "/");

// The browser demo in app/ is a separate build (make web-demo) with its own base path and its own tests: links
// to it are checked (app/index.html must exist), links inside it are not.
const SEPARATE_BUILDS = new Set([join(dist, "app")]);

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (SEPARATE_BUILDS.has(p)) return [];
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith(".html") ? [p] : [];
  });
}

const pages = new Map();
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, "utf8");
  const rel = file.slice(dist.length + 1).replace(/index\.html$/, "");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const links = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
  const srcsets = [...html.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) =>
    m[1].split(",").map((s) => s.trim().split(/\s+/)[0]),
  );
  pages.set(base + rel, { file, ids, links: [...links, ...srcsets] });
}

const problems = [];
let checked = 0;
// Links to files in this repository on GitHub ("…/blob/main/LIFELINE.md") are checked against the checkout,
// because github.com refuses automated checkers.
const repoRoot = resolve(dist, "..", "..");
const REPO_FILE = /^https:\/\/github\.com\/NeilGilani\/game\/(?:blob|tree)\/main\/([^#?]+)/;
for (const [pagePath, page] of pages) {
  for (const link of page.links) {
    const repoFile = REPO_FILE.exec(link);
    if (repoFile) {
      checked += 1;
      if (!existsSync(join(repoRoot, decodeURIComponent(repoFile[1]))))
        problems.push(`${pagePath}: ${link} → not in the repository`);
      continue;
    }
    if (/^(https?:|mailto:|data:)/.test(link)) continue;
    checked += 1;
    const url = new URL(link, `http://site${pagePath}`);
    const target = url.pathname.endsWith("/") ? url.pathname : url.pathname;
    if (!target.startsWith(base)) {
      problems.push(`${pagePath}: ${link} is outside the site's base path ${base}`);
      continue;
    }
    const onDisk = join(dist, decodeURIComponent(target.slice(base.length)));
    const exists = target.endsWith("/") ? existsSync(join(onDisk, "index.html")) : existsSync(onDisk);
    if (!exists) {
      problems.push(`${pagePath}: ${link} → missing ${target}`);
      continue;
    }
    if (url.hash) {
      const dest = pages.get(target);
      const id = decodeURIComponent(url.hash.slice(1));
      if (dest && !dest.ids.has(id)) problems.push(`${pagePath}: ${link} → no element with id="${id}"`);
    }
  }
}

if (problems.length) {
  console.error(`Broken links (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`All ${checked} internal links and anchors on ${pages.size} pages are fine.`);
