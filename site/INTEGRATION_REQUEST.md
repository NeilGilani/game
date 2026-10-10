# Integration requests from Instance 9 (landing page)

For Instance 1 unless noted. Nothing here blocks the site: it already handles every case below, but these make
the download and the copy exact.

## 1. Release assets the download panel can read (release workflow)

- Name the disk images with an explicit chip: `AGENCY-<version>-arm64.dmg` and `AGENCY-<version>-x64.dmg`, or
  `AGENCY-<version>-universal.dmg`. (An unmarked `AGENCY-<version>.dmg` next to an arm64 one is read as Intel,
  electron-builder's default; a lone unmarked one is offered without claiming a chip.)
- Upload `SHA256SUMS` (`shasum -a 256` format) with every release. GitHub's own `digest` field is used first.
- Put exactly one marker in the release notes: `<!-- agency:unsigned -->` or `<!-- agency:signed -->`. Without
  a marker the panel looks for the words "unsigned" / "not notarized".
- Keep the app's name **AGENCY** (`AGENCY.app` in Applications): the Gatekeeper steps on the site use it.
- Publish releases in `NeilGilani/game` while it is public. If it becomes private, publish them to a separate
  public repository and set the repository variable `RELEASES_REPO` (the Pages workflow passes it to the build).

## 2. `make check` and CI

The site has its own dependencies (`site/package-lock.json`). Please add to the root `Makefile`:

```make
site-setup:
	cd site && npm ci --no-audit --no-fund
site-check:
	cd site && npm run check
```

and run `make site-check` from `make check` (or from CI) once `site-setup` has run. `.github/workflows/pages.yml`
already runs the site's full suite on pull requests that touch `site/`.

## 3. THIRD_PARTY.md

Please add the site's runtime parts: Astro (MIT, build tool only), `@fontsource/atkinson-hyperlegible` 5.3.0
(SIL OFL 1.1, served by the site), sharp (Apache 2.0, build-time image resizing). The site's credits page lists
them already.

## 4. Facts the copy depends on (please confirm or correct in your PR)

`site/src/data/site.ts` and the setup guide state: macOS 13 Ventura or later; Apple silicon and Intel; Chrome for
web pages through AGENCY Bridge; permissions Camera, Accessibility, Screen Recording, Microphone (optional, calls),
Speech Recognition (optional); the API key kept in the keychain; unsigned updates forget Accessibility and Screen
Recording. If any of these changes, tell Instance 9 or edit `site.ts` directly.

Feature status is in `src/pages/index.astro` (`status: "prototype" | "building"`) with a reviewed date in
`site.ts`. Instances 2, 3, 5, 6, 7 and 8: when your feature ships in a release, say so in your PR and the status
gets updated.

## 5. Decisions for the owner (not made by any instance)

- **Turn on GitHub Pages:** Settings → Pages → Source: GitHub Actions. Until then the deploy job fails; build and
  tests still run.
- **A public contact address** for "not yet on my computer" and accessibility reports: set the repository
  variable `CONTACT_EMAIL`. Until then the site points to GitHub Issues.
- **A license** for AGENCY's own code. The credits page says honestly that none has been chosen.
- **The 60-second demo video:** record it unedited, add captions (WebVTT), put both in `site/public/demo/` and set
  `PUBLIC_DEMO_VIDEO` / `PUBLIC_DEMO_CAPTIONS`. Until then the page shows a labelled empty slot.
