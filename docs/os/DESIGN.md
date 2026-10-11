# AGENCY OS design system

AGENCY OS should feel as calm and finished as macOS, for someone who uses it only with their eyes. Polish never
costs accessibility: the bar in [PLAN.md](PLAN.md) (targets of 96 px or more, 120 px or more on Home, 24 px gaps,
paging instead of scrolling, no time limits, WCAG 2.2 AA) comes first, and every rule below is checked by tests.

Base tokens live in [`frontend/src/styles/tokens.css`](../../frontend/src/styles/tokens.css), for the light,
dark and high-contrast themes. [`frontend/src/styles/layout.css`](../../frontend/src/styles/layout.css) adds
desktop materials and responsive layouts. Home uses a Finder-style split window with a frosted sidebar;
the Dock has original icon plates and active-page dots. The menu bar's View and Help menus navigate to real
screens and support keyboard dismissal. Its small controls complement the large gaze targets on Home and the Dock.

The original vector wallpaper is [`frontend/public/desktop-wallpaper.svg`](../../frontend/public/desktop-wallpaper.svg).
High contrast removes wallpaper, transparency and icon gradients. References:
[Apple's macOS interface guidance](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/)
and [macOS Tahoe's desktop materials](https://www.apple.com/newsroom/2025/06/macos-tahoe-26-makes-the-mac-more-capable-productive-and-intelligent-than-ever/).

Short MacBook windows show six core words per Talk page instead of twelve. The page size is fixed on entry,
so choices never rearrange under a steady gaze. Settings pages its six options into five and one. Narrow
windows stack Home's panes and keep targets large; the content scrolls when it cannot fit on one screen.

## Materials

| Token | Light | Dark | High contrast | Use |
|---|---|---|---|---|
| `--wallpaper` | Soft blue, lilac and peach radial gradients | The same hues, deep | Plain black | Behind everything. Our own gradient; never an Apple wallpaper. |
| `--glass` / `--glass-strong` | White at 74% / 86% | Graphite at 72% / 86% | Solid black | Panels, cards, the menu bar, the dock |
| `--glass-blur` | `blur(30px) saturate(180%)` | same | none | Frosted glass |
| `--hairline` | 1 px, black 8% | 1 px, white 10% | 2 px white | Edges of glass |
| `--shadow`, `--shadow-lift` | Three soft layers | Deeper, fewer layers | none | Resting cards; the dock |

The glass tint is strong enough that text on it keeps at least 4.5:1 whatever the wallpaper does behind it; axe
checks every screen in all three themes.

**Lifeline is never glass.** The Lifeline screens, the emergency overlay, the Help button and the Lifeline tile are
solid `#c4001a` red with white (7:1), or solid surfaces with 2 px borders, in every theme.

## Shape

Corner radii 14 px (buttons) to 22–26 px (cards, panels); tiles and icon plates use a 30% radius so they read as
squircles. The dock is a 32 px-radius pill.

## Type

The system font (SF Pro on a Mac, via `-apple-system` / `system-ui`), with Apple's hierarchy sized up for
accessibility: large title 40 px, title 30 px, headline 23 px semibold, body **20 px**, footnote 17 px, all scaled by
the person's text-size setting. **Easy-read font** (Settings → How you choose) switches everything to Atkinson
Hyperlegible.

## Colour

Apple-style system colours, darkened where needed so text passes 4.5:1, used only for meaning:

| Role | Light | Dark | Meaning |
|---|---|---|---|
| `--accent` / `--info` | blue `#0064d2` | `#4da3ff` | The primary action, selection, information |
| `--ok` | green `#136b2d` | `#32d74b` | Done, verified, ready |
| `--warn` | orange `#a64b00` | `#ffb340` | Waiting for the person, needs attention |
| `--danger` | red `#c4001a` | `#ff6961` | Stop, failure, decline (Lifeline always uses solid `#c4001a`) |
| `--sim` | purple `#6c3fc0` | `#c9a8ff` | Simulated, demo data |

Status is always icon plus text, never colour alone. Home's tile art uses one gradient per tile (white icon on a
deep two-stop gradient, at least 3:1 for the icon).

## Icons

[Lucide](https://lucide.dev) (ISC licence), through `components/Icon.tsx`, at a 2.25 stroke. No emoji, no SF
Symbols, no Apple logos or trademarks.

## Motion

Springs of 200–350 ms (`--spring`, `--dur-fast`, `--dur`, `--dur-slow`). A new screen zooms open like Launchpad,
a new set of choices fades in, a selected target "launches" (a short scale pulse). Motion only happens on a change
the person caused, while selection is paused for the screen change; nothing moves while they are looking at it, and
hover never scales anything. **Reduce motion** (Settings) and the system setting turn all of it off.

**Dwell feedback** is a ring in the target's corner that fills like an activity ring as the dwell completes, plus a
4 px outline, so progress is visible in every theme.

## Layout

- **Menu bar** (top, 52 px, glass): AGENCY, the date and time (changes once a minute, never moves), status pills.
  Nothing in it is needed by the person: it is for helpers with a mouse.
- **Dock** (bottom, glass pill): **Help** (solid red, always first in scanning order), Home, Talk, Keyboard, Pause eye
  control (when the camera is on), **Stop agent**. Every dock button is 96 px or more.
- **Home**: a "Your usuals" widget card (greeting, up to three usuals with their reasons, Continue) beside a
  Launchpad grid of 12 squircle tiles (112–136 px icons, label underneath; the whole tile is the target).
- **Flows, Settings, Memory, Talk, tasks**: large title, glass cards, choices with a gradient icon plate, Back and
  Home at the bottom.

## How it is checked

- `e2e/axe.spec.ts`: axe-core, WCAG 2.2 A/AA rules, every screen, light, dark and high contrast: zero violations.
- `e2e/screens.spec.ts`: every OS screen at 1440 × 900 and 1280 × 800 fits without scrolling; targets 96 px or more
  (120 on Home), 24 px apart, none clipped.
- `e2e/screens.spec.ts` also saves review screenshots in `frontend/test-results/screens/`.
  Reference images are in `docs/os/design/after/`.

## Known gaps

- The Keyboard button puts the cursor in the screen's text field; the eye keyboard itself is the Mac app's overlay
  (Instance 3). Opening it from the shell needs a host API (requested in the PR).
- Glass relies on `backdrop-filter`; where it isn't supported the tint alone carries contrast.
- Not yet reviewed by people who use eye gaze every day.
