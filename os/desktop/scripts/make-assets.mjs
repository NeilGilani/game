// Renders build/src/*.svg into the app icon (.icns + 1024 PNG) and the .dmg background (1x and 2x), using
// Electron's renderer and macOS's own sips and iconutil. Run on a Mac: npx electron scripts/make-assets.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(desktop, "build");
const design = resolve(desktop, "..", "..", "docs", "os", "design");

async function render(svgFile, width, height, scale, out) {
  const svg = readFileSync(join(build, "src", svgFile), "utf8");
  const win = new BrowserWindow({ show: false, width, height, transparent: true, frame: false, useContentSize: true,
    webPreferences: { zoomFactor: 1 } });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg style="display:block;width:${width}px;height:${height}px" `)}</body></html>`;
  const tmp = join(app.getPath("temp"), `agency-asset-${Date.now()}.html`);
  writeFileSync(tmp, html);
  await win.loadFile(tmp);
  rmSync(tmp);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  writeFileSync(out, img.resize({ width: width * scale, height: height * scale, quality: "best" }).toPNG());
  win.destroy();
}


app.on("window-all-closed", () => undefined);
app.whenReady().then(async () => {
  mkdirSync(design, { recursive: true });
  await render("icon.svg", 1024, 1024, 1, join(build, "icon.png"));
  await render("dmg-background.svg", 660, 420, 1, join(build, "background.png"));
  await render("dmg-background.svg", 660, 420, 2, join(build, "background@2x.png"));
  const set = join(build, "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [mult, suffix] of [[1, ""], [2, "@2x"]]) {
      const px = size * mult;
      execFileSync("sips", ["-z", String(px), String(px), join(build, "icon.png"), "--out", join(set, `icon_${size}x${size}${suffix}.png`)], { stdio: "ignore" });
    }
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(build, "icon.icns")]);
  rmSync(set, { recursive: true, force: true });
  copyFileSync(join(build, "icon.png"), join(design, "icon-1024.png"));
  copyFileSync(join(build, "background@2x.png"), join(design, "dmg-background@2x.png"));
  console.log("Wrote build/icon.icns, build/icon.png, build/background(@2x).png");
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
