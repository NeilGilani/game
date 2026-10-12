// Usable by keyboard, switch and gaze: big targets with room between them, visible focus, no sideways scrolling,
// nothing loaded from anyone else, no cookies.
import { expect, test } from "@playwright/test";
import { PAGES, makeRelease, mockGitHub, pretend } from "./fixtures";

/** Standalone controls: everything clickable except links inside running text. */
const TARGETS =
  "a.btn, button, summary, .target-link, .site-nav a, .brand, #download-panel a:not(p a):not(dd a)";

for (const path of PAGES) {
  test(`targets are at least 96 px with 24 px between them: /${path}`, async ({ page }) => {
    await pretend(page, "macOS", "arm");
    await mockGitHub(page, { status: 200, body: makeRelease() });
    await page.goto(path);
    if (path === "download/")
      await expect(page.locator("#download-panel")).toHaveAttribute("aria-busy", "false");
    const problems = await page.$$eval(TARGETS, (els) => {
      const visible = els
        .filter((el) => {
          // Content of a closed <details> keeps a layout box in Chrome, but it isn't on screen.
          const closed = el.closest("details:not([open])");
          if (closed && !el.closest("summary")) return false;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return (
            s.visibility !== "hidden" &&
            s.display !== "none" &&
            r.width > 0 &&
            r.height > 0 &&
            !el.closest(".skip-link, .sr-only") &&
            !el.classList.contains("skip-link")
          );
        })
        .map((el) => ({
          el,
          r: el.getBoundingClientRect(),
          label: (el.textContent ?? "").trim().slice(0, 40),
        }));
      const out: string[] = [];
      for (const t of visible) {
        if (t.r.height < 95.5 || t.r.width < 95.5)
          out.push(`too small (${Math.round(t.r.width)}x${Math.round(t.r.height)}): ${t.label}`);
      }
      for (let i = 0; i < visible.length; i += 1) {
        for (let j = i + 1; j < visible.length; j += 1) {
          const a = visible[i]!;
          const b = visible[j]!;
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const dx = Math.max(0, Math.max(a.r.left, b.r.left) - Math.min(a.r.right, b.r.right));
          const dy = Math.max(0, Math.max(a.r.top, b.r.top) - Math.min(a.r.bottom, b.r.bottom));
          if (Math.max(dx, dy) < 23.5)
            out.push(`too close (${Math.round(Math.max(dx, dy))} px): "${a.label}" / "${b.label}"`);
        }
      }
      return out;
    });
    expect(problems).toEqual([]);
  });

  test(`no sideways scrolling at 320 px: /${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mockGitHub(page, { status: 404 });
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test(`loads nothing from anyone but this site and GitHub's API, and sets no cookies: /${path}`, async ({
    page,
    context,
  }) => {
    const foreign: string[] = [];
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.hostname !== "127.0.0.1" && url.hostname !== "api.github.com") foreign.push(r.url());
    });
    await mockGitHub(page, { status: 200, body: makeRelease() });
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(foreign).toEqual([]);
    expect(await context.cookies()).toEqual([]);
  });
}

test("keyboard: skip link first, every stop visibly focused, the download reachable", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "keyboard test runs on desktop");
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, { status: 200, body: makeRelease() });
  await page.goto("download/");
  await expect(page.locator("#download-panel")).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Skip to content");
  await expect(page.locator(":focus")).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);

  let reachedDownload = false;
  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press("Tab");
    const info2 = await page.evaluate(() => {
      // Mark the focused element: a video's own controls keep focus inside the player, where ":focus" can't see it.
      document.querySelector("[data-kbd-focus]")?.removeAttribute("data-kbd-focus");
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      el.setAttribute("data-kbd-focus", "");
      const s = getComputedStyle(el);
      return {
        text: (el.textContent ?? "").trim().slice(0, 60),
        outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 3,
        cls: el.className,
      };
    });
    if (!info2) break;
    expect(info2.outline, `focus outline on "${info2.text}"`).toBe(true);
    // Smooth scrolling takes a moment to bring the focused control into view.
    await expect(page.locator("[data-kbd-focus]"), `"${info2.text}" scrolled into view`).toBeInViewport();
    if (String(info2.cls).includes("dl-primary")) reachedDownload = true;
  }
  expect(reachedDownload).toBe(true);
});

test("questions open and close with the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await mockGitHub(page, { status: 404 });
  await page.goto("#faq");
  const q = page.locator("#faq summary").first();
  await q.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#faq details").first()).toHaveAttribute("open", "");
  await page.keyboard.press("Space");
  await expect(page.locator("#faq details").first()).not.toHaveAttribute("open", "");
});

test("with reduced motion, nothing is hidden waiting to animate", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockGitHub(page, { status: 404 });
  await page.goto("");
  const hidden = await page.$$eval(
    ".reveal",
    (els) => els.filter((e) => getComputedStyle(e).opacity !== "1").length,
  );
  expect(hidden).toBe(0);
});

test("on a phone, the section menu opens in place with large, well-spaced links", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the menu only exists on narrow screens");
  await mockGitHub(page, { status: 404 });
  await page.goto("");
  await page.locator(".menu summary").click();
  const links = page.locator(".menu a");
  // Both main actions, the five home-page sections, Inside AGENCY and the setup guide.
  await expect(links).toHaveCount(9);
  const boxes = await links.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect),
  );
  for (const [i, b] of boxes.entries()) {
    expect(b.height).toBeGreaterThanOrEqual(96);
    const next = boxes[i + 1];
    if (next) expect(next.top - b.bottom).toBeGreaterThanOrEqual(24);
  }
  await links.filter({ hasText: "FAQ" }).click();
  await expect(page).toHaveURL(/#faq$/);
});

for (const path of PAGES) {
  test(`both main actions are on the page, in the header and the footer: /${path}`, async ({ page }) => {
    await mockGitHub(page, { status: 404 });
    await page.goto(path);
    for (const where of [".site-header", ".site-footer"]) {
      await expect(page.locator(`${where} a[href$="/app/"]`).first()).toBeAttached();
      await expect(page.locator(`${where} a[href$="/download/"]`).first()).toBeAttached();
    }
  });
}

test("the home page offers both actions at the top and again at the end", async ({ page }) => {
  await mockGitHub(page, { status: 404 });
  await page.goto("");
  for (const where of [".hero", "#start"]) {
    await expect(page.locator(`${where} a[data-cta="try"]`)).toHaveAttribute("href", /\/app\/$/);
    await expect(page.locator(`${where} a[data-cta="download"]`)).toHaveAttribute("href", /\/download\/$/);
  }
  await expect(page.locator(".hero a[data-cta='try']")).toBeInViewport();
});

test("every photo has a description and is credited on the credits page", async ({ page }) => {
  await mockGitHub(page, { status: 404 });
  await page.goto("");
  const alts = await page.$$eval(".photo img", (imgs) => imgs.map((i) => i.getAttribute("alt") ?? ""));
  expect(alts.length).toBeGreaterThan(0);
  for (const alt of alts) expect(alt.length).toBeGreaterThan(10);
  await page.goto("credits/");
  const credited = await page.$$eval("#photos ~ .table-scroll tbody tr", (rows) =>
    rows.map((r) => r.querySelector("th span")?.textContent?.trim() ?? ""),
  );
  for (const alt of alts) expect(credited).toContain(alt);
});
