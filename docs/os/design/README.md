# AGENCY desktop: Mac design

Screenshots made on a developer Mac (macOS 26.6.2, Apple M5 Pro) on 2026-10-10.

| File | What |
|---|---|
| `icon-1024.png` | App icon (squircle on the macOS grid, 824 px body on a 1024 canvas). Source `os/desktop/build/src/icon.svg`; `.icns` made by `npx electron scripts/make-assets.mjs` (sips + iconutil) |
| `dmg-background@2x.png`, `dmg-window.png` | The `.dmg` window: background with a drag-to-Applications arrow, icons at (170, 210) and (490, 210) |
| `shell-light.png`, `shell-dark.png` | Shell window (windowed mode): `titleBarStyle: hiddenInset`, `vibrancy: under-window` |
| `about-light.png`, `about-dark.png` | About AGENCY (app menu), on the window's vibrancy |

Regenerate: `cd os/desktop && npx electron scripts/make-assets.mjs && node scripts/build.mjs && node scripts/screenshots.mjs`.

Notes:
- Colours come from the interface's current tokens (`frontend/src/styles/app.css`): accent `#0b6b5c`, focus `#f2b400`.
  Switch to Instance 7's `docs/os/DESIGN.md` tokens when that file lands (it isn't on main yet).
- The shell's vibrancy only shows where the interface is transparent. Today the interface paints its own opaque
  background (`--bg`), so the visible change is the inset title bar; making the background translucent is a design
  call for Instance 7.
- In production the shell runs full screen, where the title bar is hidden anyway.
