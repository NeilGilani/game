// Screenshots of the desktop app's Mac chrome into docs/os/design/: shell and About, light and dark.
//   node scripts/build.mjs && node scripts/screenshots.mjs
// Uses macOS `screencapture -l <window>` so vibrancy and the title bar are in the picture (needs Screen Recording
// permission for the terminal); falls back to the page content alone when that isn't allowed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(desktop, "..", "..", "docs", "os", "design");
const dir = mkdtempSync(join(tmpdir(), "agency-shots-"));

const app = await electron.launch({
  args: [desktop],
  cwd: desktop,
  env: {
    ...process.env,
    AGENCY_TEST: "1",
    AGENCY_USER_DATA: join(dir, "ud"),
    AGENCY_SKIP_ONBOARDING: "1",
    AGENCY_GAZE: "mouse",
    AGENCY_BRIDGE: "0",
    AGENCY_LOG_ECHO: "0",
  },
});

async function windowId(urlPart) {
  return app.evaluate(({ BrowserWindow }, part) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes(part));
    if (!w) return null;
    w.show();
    w.focus();
    return w.getMediaSourceId().split(":")[1];
  }, urlPart);
}

// Playwright pins prefers-color-scheme to light on pages it controls; follow the theme being captured instead.
let scheme = "light";
async function shot(urlPart, file) {
  await new Promise((r) => setTimeout(r, 800));
  for (const p of app.windows()) await p.emulateMedia({ colorScheme: scheme }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 800));
  const id = await windowId(urlPart);
  const target = join(out, file);
  try {
    execFileSync("screencapture", ["-x", "-o", "-l", id, target], { stdio: "ignore" });
    if (existsSync(target) && statSync(target).size > 20_000) return console.log(`${file}: window capture`);
  } catch {
    // fall through
  }
  const page = app.windows().find((w) => w.url().includes(urlPart));
  await page.screenshot({ path: target });
  console.log(`${file}: page content only (no Screen Recording permission for screencapture)`);
}

await app.evaluate(({ BrowserWindow }) => {
  for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes("shell")) w.setSize(1280, 800);
});
for (const theme of ["light", "dark"]) {
  scheme = theme;
  await app.evaluate(({ nativeTheme, BrowserWindow }, t) => {
    nativeTheme.themeSource = t;
    for (const w of BrowserWindow.getAllWindows()) w.webContents.reloadIgnoringCache();
  }, theme);
  await new Promise((r) => setTimeout(r, 2500));
  await shot("agency://shell/", `shell-${theme}.png`);
  await app.evaluate(() => globalThis.__agency.showAbout());
  await shot("agency://host/about", `about-${theme}.png`);
}
await app.close();
