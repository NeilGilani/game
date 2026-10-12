# AGENCY OS landing page (`site/`)

The public page where people discover AGENCY OS and download it. Owned by Instance 9.

It is a static site built with [Astro](https://astro.build). **Why Astro:** it renders every page to plain HTML
at build time and ships no JavaScript unless a component asks for it. The only script on the page finds the latest
release (about 5 KB), so the site is fast on slow connections and old Macs, works without JavaScript, and is easy
to host anywhere. It also resizes screenshots into AVIF/WebP at build time.

## What's here

| Path                              | What it is                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/`                      | Home (hero, story, how to use it, demo, who it's for, features, safety, facts, under the hood, get started, FAQ), download, setup guide, accessibility statement, privacy policy, credits, 404                                        |
| `src/data/site.ts`                | **Everything that changes as AGENCY grows:** releases repository, contact email, demo video, requirements, feature status, team                                                                                                       |
| `src/data/photos.json`            | Every photograph of people: file, alt text, author, source, licence and changes. The credits page reads it. Only CC0, public domain, CC BY or CC BY-SA; the people shown are never presented as AGENCY users                          |
| `src/lib/release.ts`              | Pure logic: reading a GitHub release, choosing the .dmg, SHA-256, signed or not, every API outcome                                                                                                                                    |
| `src/lib/platform.ts`             | Which computer and chip the visitor has (client hints, then the GPU name; never guesses from Safari's user agent)                                                                                                                     |
| `src/scripts/download.ts`         | The download panel in the browser (on `/download/`)                                                                                                                                                                                   |
| `src/assets/screenshots/`         | Real captures of the AGENCY app, plus `manifest.json` (commit and date)                                                                                                                                                               |
| `scripts/capture-screenshots.mjs` | Captures those screenshots from the real app with Playwright                                                                                                                                                                          |
| `scripts/check-links.mjs`         | Offline check of every internal link, `#anchor`, and link to a file in this repository                                                                                                                                                |
| `scripts/serve.mjs`               | Tiny static server at `/game/`, used by the tests and Lighthouse                                                                                                                                                                      |
| `tests/unit/`                     | Vitest: release and platform logic                                                                                                                                                                                                    |
| `tests/e2e/`                      | Playwright: axe on every page (light and dark, desktop and phone), keyboard, 96 px targets with 24 px gaps, 320 px width, no third-party requests, no cookies, reduced motion, and every download state against a stand-in GitHub API |

## Commands

```sh
cd site
npm ci --workspace site   # from the repository root (site is an npm workspace)
npm run dev          # http://localhost:4321/game/
npm run check        # Prettier, astro check + tsc (strict), unit tests, build, link check
npm run test:e2e     # browser tests (first time: npx playwright install chromium)
npx lhci autorun --config=lighthouserc.json          # desktop budgets
npx lhci autorun --config=lighthouserc.mobile.json   # mobile budgets
```

With an installed Google Chrome you can skip Playwright's browser download: `PW_CHANNEL=chrome npm run test:e2e`.
For Lighthouse, set `CHROME_PATH` to Chrome if it isn't found.

### Screenshots

Every screenshot is a real capture of the app, never a mock-up. To refresh them:

```sh
make setup                      # repository root, once
(cd frontend && npm run build)
cd site && npm run screenshots  # PW_CHANNEL=chrome to use an installed Chrome
```

The script starts a real coordinator with demo data on port 8791, drives the app, and rewrites the PNGs and
`manifest.json`. Captions on the site show the capture date. When AGENCY OS screens (the new Home, Talk, the
overlay) exist, add them to the script and remove the prototype ones they replace.

## The download panel

It asks `https://api.github.com/repos/<RELEASES_REPO>/releases/latest` and shows:

- **A release:** the .dmg for the visitor's chip (Apple silicon or Intel; universal if there is one), the other one,
  version, date, size and SHA-256 (GitHub's own `digest` field, else the release's `SHA256SUMS` file, else it says
  it wasn't published). Unsigned builds show the Gatekeeper steps, already expanded.
- **No release yet** (public repository, no releases): says so and points to the releases page and the prototype.
- **Private repository:** GitHub answers 404 to visitors who aren't signed in, so release files can't be downloaded.
  The panel explains it and the two fixes: make the repository public, or publish releases to a separate public
  repository and build with `PUBLIC_RELEASES_REPO=<owner>/<repo>`.
- **Rate limited / offline / odd answer:** falls back to the releases page link.
- **Not a Mac:** "not yet", with an email link (or GitHub Issues until an address is chosen). No forms.

Without JavaScript the panel is a link to the releases page.

## Configuration (build-time environment)

| Variable                                    | Default                        | Meaning                                                           |
| ------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `PUBLIC_RELEASES_REPO`                      | `NeilGilani/game`              | Repository whose Releases hold the .dmg                           |
| `PUBLIC_CONTACT_EMAIL`                      | empty → GitHub Issues          | Public address for "tell us" links                                |
| `PUBLIC_DEMO_VIDEO`, `PUBLIC_DEMO_CAPTIONS` | empty → honest placeholder     | Paths under `public/` to a real recording and its WebVTT captions |
| `SITE_URL`                                  | `https://neilgilani.github.io` | Origin, for canonical links                                       |
| `SITE_BASE`                                 | `/game/`                       | Base path (`/` for a custom domain, Vercel or Netlify)            |

## Deploying

**GitHub Pages (default).** `.github/workflows/pages.yml` builds and tests on every pull request that touches
`site/`, and deploys on pushes to `main`. One-time setup by the repository owner: **Settings → Pages → Source:
GitHub Actions**. Repository variables `RELEASES_REPO`, `CONTACT_EMAIL`, `SITE_URL` and `SITE_BASE` feed the
build. The site will be at `https://neilgilani.github.io/game/`.

**Vercel.** Import the repository, set **Root Directory** to `site`, framework preset Astro, build command
`npm run build`, output `dist`, and environment variable `SITE_BASE=/` (plus `SITE_URL=https://<your domain>`).

**Netlify.** New site from Git, base directory `site`, build command `npm run build`, publish directory
`site/dist`, environment `SITE_BASE=/` and `SITE_URL`.

**Cloudflare Pages.** `make site-deploy` (from the repository root) builds the web demo into `/app/` and the site
with `SITE_BASE=/`, then deploys. Cloudflare may add a suffix to the project's `pages.dev` address, so set
`SITE_URL` to the address it prints (or your own domain) for correct canonical links:
`SITE_URL=https://<your address> make site-deploy`. No page hard-codes the host name; canonical and share links
come from `SITE_URL`, and every other link is relative to `SITE_BASE`.

**Anywhere else.** `SITE_BASE=/ npm run build` and upload `dist/`. Any static host works. If your host can set
headers, add the CSP from `src/layouts/Base.astro` as a real header too.

## Rules this site keeps

- No trackers, analytics, cookies or third-party fonts. The only outside request is GitHub's release API (tested).
- Honest copy: no testimonials, user counts or invented statistics; no "medical-grade"; simulated things say so;
  each feature carries its real status (`src/data/site.ts`, reviewed date). Facts about care cite their source.
- Usable by gaze, switch, keyboard, screen reader and mouse: 96 px targets with 24 px gaps, visible focus, "Next"
  links between sections, reduced motion respected, light and dark, 320 px wide without sideways scrolling.
