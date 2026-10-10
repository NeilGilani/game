/**
 * Rectangle accuracy for eye-control targets: the bridge's web Targets (global screen points) must land
 * where the elements really are, at any page zoom and device pixel ratio, scrolled or not.
 *
 * Oracle 1 (always): Chrome's own screen coordinates. Playwright clicks the centre of each box; the page
 * records MouseEvent.screenX/Y, which Chrome computes from its real window and toolbar layout. The
 * target's centre must match within 1 point.
 * Oracle 2 (PIXEL_CHECK=1, macOS, headed): the screen itself. `screencapture` grabs a few pixels at each
 * target's predicted centre, and their colour must be the box's colour. Needs Screen Recording permission
 * for the terminal, and the test window must not be covered.
 */

import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Target, TargetSnapshot } from "../../contracts/src/index.ts";
import { LAB_BOXES } from "../../sandbox-web/src/sites/misc.ts";
import { startRig, type Rig } from "./harness.ts";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const PIXEL = process.env.PIXEL_CHECK === "1" && process.platform === "darwin";
const CONFIGS = PIXEL
  ? [{ dsf: 0, headed: true }]
  : [
      { dsf: 1, headed: false },
      { dsf: 2, headed: false },
    ];

async function latestTargets(
  rig: Rig,
  after: number,
  want: (s: TargetSnapshot) => boolean,
): Promise<TargetSnapshot> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error("No matching targets snapshot."));
    }, 8000);
    const off = rig.bridge.onEvent((e) => {
      if (e.type === "targets" && e.snapshot.t >= after && want(e.snapshot)) {
        clearTimeout(t);
        off();
        resolve(e.snapshot);
      }
    });
  });
}

const centre = (t: Target) => ({ x: t.rect.x + t.rect.width / 2, y: t.rect.y + t.rect.height / 2 });

function pixelAt(x: number, y: number): [number, number, number] {
  const dir = mkdtempSync(join(tmpdir(), "agb-px-"));
  try {
    const png = join(dir, "p.png");
    const bmp = join(dir, "p.bmp");
    execFileSync("screencapture", ["-x", `-R${Math.round(x) - 2},${Math.round(y) - 2},4,4`, png]);
    execFileSync("sips", ["-s", "format", "bmp", png, "--out", bmp], { stdio: "ignore" });
    const b = readFileSync(bmp);
    const off = b.readUInt32LE(10);
    const bpp = b.readUInt16LE(28) / 8;
    // Bottom-up rows; any pixel near the middle will do.
    const o = off + bpp * 2;
    return [b[o + 2]!, b[o + 1]!, b[o]!];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hexRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

for (const cfg of CONFIGS) {
  test.describe(`targets at device pixel ratio ${cfg.dsf || "native"}${cfg.headed ? " (headed)" : ""}`, () => {
    let rig: Rig;
    let tabId: number;
    test.beforeAll(async () => {
      rig = await startRig({
        headless: !cfg.headed,
        viewport: null,
        args: [
          "--window-position=60,50",
          "--window-size=1240,940",
          ...(cfg.dsf ? [`--force-device-scale-factor=${cfg.dsf}`] : []),
        ],
      });
      ({ tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("lab") }));
    });
    test.afterAll(async () => {
      await rig?.close();
    });

    for (const zoom of ZOOMS) {
      test(`zoom ${zoom * 100}%: every target lands on its element`, async () => {
        const page = rig.context.pages().find((p) => p.url().includes("lab.localhost"))!;
        await page.bringToFront();
        await page.evaluate(() => scrollTo(0, 0));
        const sw = rig.context.serviceWorkers()[0]!;
        const since = Date.now();
        const snapP = latestTargets(rig, since, (s) => s.targets.some((t) => t.label === "box-a"));
        await sw.evaluate(([id, z]) => chrome.tabs.setZoom(id as number, z as number), [tabId, zoom]);
        const snap = await snapP;
        // Wait for the snapshot that reflects this zoom (the size of box-a scales with it).
        let s = snap;
        for (
          let i = 0;
          i < 20 && Math.abs((s.targets.find((t) => t.label === "box-a")?.rect.width ?? 0) - 120 * zoom) > 1;
          i++
        )
          s = await latestTargets(rig, since, (x) => x.targets.some((t) => t.label === "box-a"));
        const dpr = await page.evaluate(() => devicePixelRatio);
        if (cfg.dsf) expect(dpr).toBeCloseTo(cfg.dsf * zoom, 5);

        const visible = LAB_BOXES.filter((b) => s.targets.some((t) => t.label === b.id));
        expect(visible.length).toBeGreaterThanOrEqual(zoom <= 1 ? 4 : 2);
        for (const box of visible) {
          const t = s.targets.find((x) => x.label === box.id)!;
          expect(t.source).toBe("web");
          expect(t.role).toBe("button");
          // Size scales with zoom (clipped boxes at the viewport edge excepted).
          const c = centre(t);
          const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
          const fullyIn = box.x + box.w <= vp.w && box.y + box.h <= vp.h;
          if (fullyIn) {
            expect(t.rect.width).toBeCloseTo(box.w * zoom, 0);
            expect(t.rect.height).toBeCloseTo(box.h * zoom, 0);
          }
          if (!fullyIn) continue;
          const bb = (await page.locator(`#${box.id}`).boundingBox())!;
          await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
          const click = await page.evaluate(() =>
            (
              window as unknown as { __clicks: Array<{ id: string; screenX: number; screenY: number }> }
            ).__clicks.at(-1)!,
          );
          expect(click.id).toBe(box.id);
          expect(Math.abs(c.x - click.screenX)).toBeLessThanOrEqual(1);
          expect(Math.abs(c.y - click.screenY)).toBeLessThanOrEqual(1);
          if (PIXEL) {
            // Sample inside the box but away from its white label. Colour management shifts colours, so
            // the check is that the screen shows this box's colour rather than any other box or the page.
            const px = pixelAt(t.rect.x + t.rect.width * 0.15, t.rect.y + t.rect.height * 0.2);
            const palette = [
              ...LAB_BOXES.map((x) => ({ id: x.id, rgb: hexRgb(x.color) })),
              { id: "page", rgb: hexRgb("#ffffff") },
            ];
            const dist = (a: number[], b: number[]) =>
              a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0);
            const nearest = palette.reduce((best, p) => (dist(px, p.rgb) < dist(px, best.rgb) ? p : best));
            expect(nearest.id, `screen pixel ${px} at ${box.id}`).toBe(box.id);
          }
        }
      });
    }

    test("scrolling moves targets, and off-screen elements become targets when scrolled into view", async () => {
      const page = rig.context.pages().find((p) => p.url().includes("lab.localhost"))!;
      const sw = rig.context.serviceWorkers()[0]!;
      await sw.evaluate((id) => chrome.tabs.setZoom(id as number, 1), tabId);
      await page.evaluate(() => scrollTo(0, 0));
      await latestTargets(rig, Date.now() - 50, (s) => s.targets.some((t) => t.label === "box-a"));
      const since = Date.now();
      const p = latestTargets(rig, since, (s) => s.targets.some((t) => t.label === "box-e"));
      await page.evaluate(() => scrollTo(0, 1200));
      const s = await p;
      expect(s.targets.some((t) => t.label === "box-a")).toBe(false);
      const t = s.targets.find((x) => x.label === "box-e")!;
      const bb = (await page.locator("#box-e").boundingBox())!;
      await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
      const click = await page.evaluate(() =>
        (window as unknown as { __clicks: Array<{ screenX: number; screenY: number }> }).__clicks.at(-1)!,
      );
      expect(Math.abs(centre(t).x - click.screenX)).toBeLessThanOrEqual(1);
      expect(Math.abs(centre(t).y - click.screenY)).toBeLessThanOrEqual(1);
    });
  });
}

test.describe("target metadata", () => {
  let rig: Rig;
  test.beforeAll(async () => {
    rig = await startRig();
  });
  test.afterAll(async () => {
    await rig?.close();
  });

  test("password fields are marked secure, AGENCY's Stop is a protected target, covered elements are left out", async () => {
    const since = Date.now();
    const p = latestTargets(rig, since, (s) => s.targets.some((t) => t.label === "Password"));
    const { tabId } = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("bank") });
    const s = await p;
    expect(s.owner).toBe(new URL(rig.sandbox.url("bank")).origin);
    expect(s.targets.find((t) => t.label === "Password")?.secure).toBe(true);
    expect(s.targets.find((t) => t.label === "Username")?.secure).toBeUndefined();
    expect(s.targets.every((t) => t.id.startsWith(`web:${tabId}:`))).toBe(true);

    const p2 = latestTargets(rig, Date.now(), (x) => x.targets.some((t) => t.label === "Stop AGENCY"));
    const mail = await rig.bridge.call("tabs.open", { url: rig.sandbox.url("mail") });
    await rig.bridge.call("session.start", { tabId: mail.tabId, taskId: "t1" });
    const s2 = await p2;
    const stop = s2.targets.find((t) => t.label === "Stop AGENCY")!;
    expect(stop.protected).toBe(true);
    expect(stop.rect.width).toBeGreaterThanOrEqual(96);
    expect(stop.rect.height).toBeGreaterThanOrEqual(96);
    // The site's header links sit under AGENCY's banner while it works, so they aren't offered as targets.
    expect(s2.targets.some((t) => t.label.startsWith("Inbox"))).toBe(false);
    await rig.bridge.call("session.end", { tabId: mail.tabId });
  });
});
