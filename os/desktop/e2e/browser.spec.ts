/**
 * AGENCY Browser end to end in AGENCY.app: the shell's controls, the page in its WebContentsView, the page preload,
 * and main's rules, on local pages only (e2e/fixtures/browser, served at library.localhost; nothing real). The last
 * part runs the real agent (os/agent, its ordering pack and guard) on the sandbox shop (os/sandbox-web).
 *
 * The person is played with the mouse on the shell's own controls (the same buttons a dwell clicks). Page state is
 * read back from the page itself, not from what AGENCY says.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { startFixtures, type Fixtures } from "./browser-fixtures";

const desktop = resolve(__dirname, "..");
const repo = resolve(desktop, "..", "..");
const realAgent = join(repo, "os", "agent", "dist", "agent-utility.mjs");

interface Ctx {
  app: ElectronApplication;
  shell: Page;
  dir: string;
}

async function launch(env: Record<string, string> = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), "agency-browser-e2e-"));
  const app = await electron.launch({
    // A pretend camera, so a page's camera request really reaches AGENCY's rules (there is no camera here).
    args: [desktop, "--use-fake-device-for-media-stream"],
    cwd: desktop,
    env: {
      ...process.env,
      AGENCY_TEST: "1",
      AGENCY_USER_DATA: join(dir, "userdata"),
      AGENCY_SKIP_ONBOARDING: "1",
      AGENCY_NATIVE_PATH: join(desktop, "fakes", "fake-native.cjs"),
      AGENCY_AGENT_ENTRY: join(desktop, "fakes", "fake-agent.cjs"),
      AGENCY_LOG_ECHO: "0",
      AGENCY_GAZE: "mouse",
      AGENCY_BRIDGE: "0",
      AGENCY_OVERLAY_BUILTIN: "1",
      ...env,
    },
  });
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      if (w.webContents.getURL().includes("shell")) w.setContentSize(1440, 900);
  });
  await expect
    .poll(() => app.windows().some((w) => w.url().startsWith("agency://shell/")), { timeout: 30_000 })
    .toBe(true);
  const shell = app.windows().find((w) => w.url().startsWith("agency://shell/"))!;
  await shell.evaluate(() => localStorage.setItem("agency.onboarded", "1"));
  return { app, shell, dir };
}

type Tab = { id: number; url: string; loading: boolean; title: string; security: string; video: unknown };

async function tabs(c: Ctx): Promise<{ tabs: Tab[]; activeId: number | null }> {
  return c.shell.evaluate(() => window.agency.browser!.state()) as Promise<{
    tabs: Tab[];
    activeId: number | null;
  }>;
}

async function active(c: Ctx): Promise<Tab> {
  const s = await tabs(c);
  return s.tabs.find((t) => t.id === s.activeId)!;
}

/** Opens a page in AGENCY Browser, as the address box does, and waits for it. */
async function openPage(c: Ctx, url: string, newTab = false): Promise<void> {
  await c.shell.evaluate(() => (location.hash = "/internet"));
  await expect(c.shell.locator(".bw")).toBeVisible();
  // In the tab showing, as the address box does (or a new tab).
  const r = await c.shell.evaluate(
    async ([u, n]) => {
      const b = window.agency.browser!;
      const s = await b.state();
      return n || s.activeId === null
        ? b.open({ url: u as string, newTab: true })
        : b.navigate(s.activeId, u as string);
    },
    [url, newTab] as const,
  );
  expect(r.ok).toBe(true);
  await expect
    .poll(async () => {
      const t = await active(c);
      return t.url.startsWith(url.split("#")[0]!) && !t.loading;
    })
    .toBe(true);
  await expect.poll(() => pageShowing(c)).toBe(true);
}

/** The page's own state, read in the page (test only). */
async function inPage<T>(c: Ctx, part: string, code: string): Promise<T> {
  return c.app.evaluate(
    async ({ webContents }, [p, js]) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(p as string));
      if (!wc) throw new Error(`no page ${p}`);
      return wc.executeJavaScript(js as string);
    },
    [part, code] as const,
  ) as Promise<T>;
}

function pageShowing(c: Ctx): Promise<boolean> {
  return c.app.evaluate(() =>
    Boolean(
      (globalThis as unknown as { __agency: { browser: { pageShowing: boolean } } }).__agency.browser
        ?.pageShowing,
    ),
  );
}

/** The numbers showing now (each set in turn): clicks the one whose name matches, or returns what it saw. */
async function pickNumber(c: Ctx, name: RegExp): Promise<string[] | null> {
  const label = c.shell.locator(".bw-label");
  await expect(label.first()).toBeVisible();
  const more = c.shell.getByRole("button", { name: /^More numbers/ });
  const sets = (await more.count()) ? Number(/of (\d+)/.exec(await more.innerText())?.[1] ?? 1) : 1;
  let seen: string[] = [];
  for (let set = 0; set < sets; set++) {
    if (set > 0) await more.click();
    seen = await label.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    const i = seen.findIndex((l) => name.test(l));
    if (i >= 0) {
      await label.nth(i).click();
      return null;
    }
  }
  return seen;
}

/**
 * Choose on page, then the number whose name matches, as a person would find it: through the sets of numbers, through
 * the lettered areas of a crowded page (zooming into each), and paging down (with the big button) for one below.
 */
async function chooseLabel(c: Ctx, name: RegExp): Promise<void> {
  let seen: string[] = [];
  for (let page = 0; page < 6; page++) {
    await c.shell.getByRole("button", { name: "Choose on page" }).click();
    await expect(c.shell.locator(".bw-label, .bw-area").first()).toBeVisible();
    const areas = await c.shell.locator(".bw-area").count();
    if (!areas) {
      const r = await pickNumber(c, name);
      if (!r) return;
      seen = r;
    } else {
      for (let a = 0; a < areas; a++) {
        await c.shell.locator(".bw-area").nth(a).click();
        const r = await pickNumber(c, name);
        if (!r) return;
        seen = r;
        await c.shell.getByRole("button", { name: "Whole page" }).click();
        await expect(c.shell.locator(".bw-area").first()).toBeVisible();
      }
    }
    await c.shell.getByRole("button", { name: "Done choosing" }).click();
    await expect.poll(() => pageShowing(c)).toBe(true);
    await c.shell.getByRole("button", { name: "Page down" }).click();
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`no label for ${name} in ${seen.join(" | ")}`);
}

test.describe("AGENCY Browser", () => {
  let c: Ctx;
  let site: Fixtures;

  test.beforeAll(async () => {
    test.skip(
      !existsSync(join(repo, "backend", ".venv", "bin", "python")),
      "needs backend/.venv (make setup-backend)",
    );
    site = await startFixtures();
    c = await launch();
  });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus)
      await c.shell.screenshot({ path: info.outputPath("shell.png") }).catch(() => undefined);
  });
  test.afterAll(async () => {
    await c?.app.close();
    await site?.close();
  });

  test("Home's Internet tile opens it, with the start page's sites", async () => {
    await c.shell.evaluate(() => (location.hash = "/"));
    await c.shell.getByRole("button", { name: /^Internet:/ }).click();
    await expect(c.shell).toHaveURL(/#\/internet$/);
    await expect(c.shell.getByRole("button", { name: /^Wikipedia:/ })).toBeVisible();
    await expect(c.shell.getByRole("button", { name: "Search or type a web address" }).first()).toBeVisible();
  });

  test("pages run isolated: their own session, sandboxed, no AGENCY or Node in the page, no role in main", async () => {
    await openPage(c, site.url("/"));
    const globals = await inPage<string>(
      c,
      "library.localhost",
      "[typeof window.agency, typeof require, typeof process, typeof ipcRenderer, typeof electron].join(',')",
    );
    expect(globals).toBe("undefined,undefined,undefined,undefined,undefined");
    const facts = await c.app.evaluate(({ webContents, session }) => {
      const a = (globalThis as any).__agency;
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes("library.localhost"))!;
      let refused = "";
      try {
        a.requireRole({ sender: wc }, ["shell"]);
      } catch (e) {
        refused = (e as Error).message;
      }
      const prefs = (
        wc as unknown as { getLastWebPreferences(): Record<string, unknown> }
      ).getLastWebPreferences();
      return {
        role: a.roleOf(wc),
        refused,
        ownSession: wc.session === a.browser.session,
        notDefault: wc.session !== session.defaultSession,
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        webSecurity: prefs.webSecurity,
        insecure: prefs.allowRunningInsecureContent,
        partition: wc.session.storagePath?.includes("agency-browser") ?? null,
      };
    });
    expect(facts).toMatchObject({
      role: null,
      refused: "not allowed from unknown window",
      ownSession: true,
      notDefault: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      insecure: false,
    });
    // The page can't reach AGENCY's coordinator, even in the background.
    const coordinator = await c.app.evaluate(() => (globalThis as any).__agency.client.current.url as string);
    const fetched = await inPage<string>(
      c,
      "library.localhost",
      `fetch(${JSON.stringify(`${coordinator}/api/health`)}).then(() => "reached", () => "blocked")`,
    );
    expect(fetched).toBe("blocked");
  });

  test("Choose on page: a numbered label clicks for real (a trusted click), then a link opens", async () => {
    await openPage(c, site.url("/"));
    await chooseLabel(c, /Say hello/);
    await expect
      .poll(() => inPage<string>(c, "library.localhost", "document.getElementById('status').textContent"))
      .toBe("pressed by a person");
    // The page is live again, and Choose on page works on it again.
    await expect.poll(() => pageShowing(c)).toBe(true);
    await chooseLabel(c, /^\d+: Stories$/);
    await expect.poll(async () => (await active(c)).url).toContain("/article.html");
  });

  test("the side list: the same targets by name, repeated names merged", async () => {
    await openPage(c, site.url("/"));
    await c.shell.getByRole("button", { name: "Choose on page" }).click();
    await expect(c.shell.getByRole("group", { name: "Things on the page, by name" })).toBeVisible();
    const readMore = c.shell.locator(".bw-list-btn", { hasText: "Read more" });
    if (!(await readMore.count())) {
      // On another page of the list.
      for (let i = 0; i < 5 && !(await readMore.count()); i++)
        await c.shell.getByRole("button", { name: "More names" }).click();
    }
    await expect(readMore).toContainText("3 on the page");
    await readMore.click();
    await expect(c.shell.locator(".bw-label")).toHaveCount(3);
    await c.shell.getByRole("button", { name: "Done choosing" }).click();
    await expect.poll(() => pageShowing(c)).toBe(true);
  });

  test("a crowded page: lettered areas first, then numbers touching their links in the zoomed area", async () => {
    await openPage(c, site.url("/dense.html"));
    await c.shell.getByRole("button", { name: "Choose on page" }).click();
    const areas = c.shell.locator(".bw-area");
    await expect(areas.first()).toBeVisible();
    expect(await areas.count()).toBeGreaterThan(3);
    expect(await c.shell.locator(".bw-label").count()).toBe(0);
    await areas.first().click();
    const labels = c.shell.locator(".bw-label");
    await expect(labels.first()).toBeVisible();
    // Each number touches the outline of its own link.
    const touching = await labels.evaluateAll((els) =>
      els.every((el) => {
        const chip = el.querySelector(".bw-label-chip")!.getBoundingClientRect();
        const box = el.querySelector(".bw-target-box")!.getBoundingClientRect();
        return (
          chip.left <= box.right + 1 &&
          box.left <= chip.right + 1 &&
          chip.top <= box.bottom + 1 &&
          box.top <= chip.bottom + 1
        );
      }),
    );
    expect(touching).toBe(true);
    const name = (await labels.first().getAttribute("aria-label"))!.replace(/^\d+: /, "");
    await labels.first().click();
    await expect
      .poll(() => inPage<string>(c, "dense.html", "document.getElementById('picked').textContent"))
      .toBe(name);
  });

  test("Zoom to choose: a lens over small crowded links, then the link in it", async () => {
    await openPage(c, site.url("/dense.html"));
    await c.shell.getByRole("button", { name: "Zoom to choose" }).click();
    await c.shell.locator(".bw-cell").nth(2).click();
    await expect(c.shell.locator(".bw-lens")).toBeVisible();
    const items = c.shell.locator(".bw-lens-item");
    expect(await items.count()).toBeGreaterThan(4);
    const box = await items.first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    const name = (await items.first().getAttribute("aria-label"))!;
    await items.first().click();
    await expect
      .poll(() => inPage<string>(c, "dense.html", "document.getElementById('picked').textContent"))
      .toBe(name);
  });

  test("a form with the eye keyboard: typed into the page, Next box, never a password, then submitted", async () => {
    await openPage(c, site.url("/form.html"));
    await chooseLabel(c, /Your name/);
    await expect(c.shell.locator(".bw-formbar")).toContainText("Your name");
    const key = (k: string) =>
      c.shell
        .locator(".eye-keyboard button")
        .filter({ hasText: new RegExp(`^${k}$`, "i") })
        .first();
    await expect(c.shell.locator(".eye-keyboard")).toBeVisible();
    for (const k of ["R", "u", "t", "h"]) await key(k).click();
    await expect
      .poll(() => inPage<string>(c, "form.html", "document.getElementById('name').value"))
      .toBe("Ruth");
    // The page stays in view above the keyboard and the typing bar.
    const view = await c.app.evaluate(() => {
      const b = (globalThis as any).__agency.browser;
      const t = [...b.tabs.values()].find((x: any) => x.id === b.activeId);
      return t.view.getBounds() as { y: number; height: number };
    });
    const bar = await c.shell.locator(".bw-formbar").boundingBox();
    expect(view.y + view.height).toBeLessThanOrEqual(bar!.y);
    await c.shell.getByRole("button", { name: "Next box" }).click();
    await expect(c.shell.locator(".bw-formbar")).toContainText("Email");
    await c.shell.getByRole("button", { name: "Next box" }).click();
    await expect(c.shell.locator(".bw-formbar")).toContainText("Password box");
    await expect(c.shell.locator(".bw-formbar")).toContainText("never types passwords");
    await expect(c.shell.locator(".eye-keyboard")).toHaveCount(0);
    expect(await inPage<string>(c, "form.html", "document.getElementById('password').value")).toBe("");
    await c.shell.getByRole("button", { name: "Done" }).click();
    // Submitting from the name box.
    await chooseLabel(c, /Your name/);
    await c.shell
      .locator(".bw-formbar")
      .getByRole("button", { name: /Join now/ })
      .click();
    await expect.poll(async () => (await active(c)).url).toContain("/thanks?name=Ruth");
  });

  test("a list (select) becomes big choices", async () => {
    await openPage(c, site.url("/form.html"));
    await chooseLabel(c, /Branch/);
    await c.shell.getByRole("dialog").getByRole("button", { name: "Hilltop" }).click();
    await expect
      .poll(() => inPage<string>(c, "form.html", "document.getElementById('branch').value"))
      .toBe("Hilltop");
  });

  test("scrolling: Page down, and the glide zone", async () => {
    await openPage(c, site.url("/article.html"));
    const y = () => inPage<number>(c, "article.html", "Math.round(scrollY)");
    expect(await y()).toBe(0);
    await c.shell.getByRole("button", { name: "Page down" }).click();
    await expect.poll(y).toBeGreaterThan(200);
    const before = await y();
    // A resting look (the mouse here) on Scroll up glides the page up.
    await c.shell.getByRole("button", { name: /^Scroll up/ }).hover();
    await expect.poll(y, { timeout: 5_000 }).toBeLessThan(before);
    await c.shell.mouse.move(5, 5);
  });

  test("Reader view: the article as big text, in pages", async () => {
    await openPage(c, site.url("/article.html"));
    await c.shell.getByRole("button", { name: "Reader view" }).click();
    const reader = c.shell.getByRole("dialog", { name: "Reader view" });
    await expect(reader.getByRole("heading", { name: "How the community garden grew" })).toBeVisible();
    await expect(reader).toContainText("Ruth Okafor");
    await expect(reader).toContainText("Five years ago");
    await expect(reader).not.toContainText("Opening hours");
    expect(await pageShowing(c)).toBe(false);
    const pageno = reader.locator(".bw-reader-pageno");
    await expect(pageno).toContainText("Page 1 of");
    await reader.getByRole("button", { name: "Bigger text" }).click();
    await reader.getByRole("button", { name: "Next page" }).click();
    await expect(pageno).toContainText("Page 2 of");
    await reader.getByRole("button", { name: "Close reader" }).click();
    await expect.poll(() => pageShowing(c)).toBe(true);
  });

  test("window.open and target=_blank open tabs here, never windows; the tab switcher", async () => {
    await openPage(c, site.url("/"));
    const windowsBefore = await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const before = (await tabs(c)).tabs.length;
    await chooseLabel(c, /Open the story in a new tab/);
    await expect.poll(async () => (await tabs(c)).tabs.length).toBe(before + 1);
    await expect.poll(async () => (await active(c)).url).toContain("/article.html");
    await c.shell.getByRole("button", { name: "Back" }).click();
    // A script's window.open, from a real click on its button.
    const back = (await tabs(c)).tabs.find((t) => t.url === site.url("/"));
    if (back) await c.shell.evaluate((id) => window.agency.browser!.activateTab(id), back.id);
    await expect.poll(() => pageShowing(c)).toBe(true);
    await chooseLabel(c, /Open the form in a new window/);
    await expect.poll(async () => (await tabs(c)).tabs.some((t) => t.url.includes("/form.html"))).toBe(true);
    expect(await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
      windowsBefore,
    );
    await c.shell.getByRole("button", { name: /^Tabs:/ }).click();
    const overlay = c.shell.getByRole("dialog", { name: "Your tabs" });
    await expect(overlay.locator(".bw-tabcard")).toHaveCount((await tabs(c)).tabs.length);
    await overlay
      .getByRole("button", { name: /Go to tab: Maple Street Library/ })
      .first()
      .click();
    await expect.poll(async () => (await active(c)).title).toBe("Maple Street Library");
  });

  test("blocked: file links and AGENCY's own services; http shows Not secure", async () => {
    await openPage(c, site.url("/"));
    await chooseLabel(c, /A file on this computer/);
    await expect(c.shell.locator(".bw-strip")).toContainText("Files on this computer can't be opened");
    expect((await active(c)).url).toBe(site.url("/"));
    const coordinator = await c.app.evaluate(() => (globalThis as any).__agency.client.current.url as string);
    const r = await c.shell.evaluate(
      ([u]) => window.agency.browser!.navigate((window as any).__tab ?? 1, u as string),
      [`${coordinator}/api/lifeline/status`],
    );
    expect(r).toMatchObject({ ok: false, error: "That is part of AGENCY itself, not a web page." });
    const r2 = await c.shell.evaluate(() => window.agency.browser!.open({ url: "file:///etc/hosts" }));
    expect(r2.ok).toBe(false);
  });

  test("permissions: asked per site with big choices; the camera is never a page's", async () => {
    await openPage(c, site.url("/dense.html"));
    await chooseLabel(c, /Use my location/);
    const sheet = c.shell.getByRole("dialog", { name: "A site is asking" });
    await expect(sheet).toContainText("wants to know where you are");
    expect(await pageShowing(c)).toBe(false);
    await expect(sheet.getByRole("button", { name: "One moment…" })).toBeDisabled();
    await sheet.getByRole("button", { name: "Not now" }).click();
    await expect
      .poll(() => inPage<string>(c, "dense.html", "document.getElementById('perm').textContent"))
      .toBe("denied");
    await chooseLabel(c, /Video call a librarian/);
    await expect
      .poll(() => inPage<string>(c, "dense.html", "document.getElementById('perm').textContent"))
      .toBe("camera denied");
    await expect(c.shell.locator(".bw-strip")).toContainText("AGENCY's camera follows your eyes");
  });

  test("downloads wait for a yes, and land in Downloads", async () => {
    await openPage(c, site.url("/dense.html"));
    await chooseLabel(c, /Download the reading list/);
    const sheet = c.shell.getByRole("dialog", { name: "Save a file" });
    await expect(sheet).toContainText("reading-list.txt");
    const downloads = join(c.dir, "userdata", "Downloads");
    expect(existsSync(join(downloads, "reading-list.txt"))).toBe(false);
    await expect(sheet.getByRole("button", { name: "Save to Downloads" })).toBeEnabled();
    await sheet.getByRole("button", { name: "Save to Downloads" }).click();
    await expect.poll(() => existsSync(join(downloads, "reading-list.txt"))).toBe(true);
    await chooseLabel(c, /Download the reading list/);
    await c.shell
      .getByRole("dialog", { name: "Save a file" })
      .getByRole("button", { name: "Don't save" })
      .click();
    await new Promise((r) => setTimeout(r, 800));
    expect(readdirSync(downloads).filter((f) => f.startsWith("reading-list"))).toEqual(["reading-list.txt"]);
  });

  test("a pop-up's own buttons as big choices, Reject all first", async () => {
    await openPage(c, site.url("/popup.html"));
    await c.shell.getByRole("button", { name: "Close pop-up" }).click();
    const sheet = c.shell.getByRole("dialog", { name: "Pop-up" });
    await expect(sheet).toContainText("The site asks about cookies");
    const first = sheet.locator(".bw-option").first();
    await expect(first).toHaveText(/Reject all/);
    await first.click();
    await expect
      .poll(() => inPage<string>(c, "popup.html", "document.getElementById('choice').textContent"))
      .toBe("reject");
  });

  test("video: big Play, 10 seconds forward, captions", async () => {
    await openPage(c, site.url("/video.html"));
    const bar = c.shell.getByRole("group", { name: "Video" });
    await expect(bar).toBeVisible();
    await bar.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(() => inPage<boolean>(c, "video.html", "!document.getElementById('v').paused"))
      .toBe(true);
    await bar.getByRole("button", { name: "Pause" }).click();
    await expect
      .poll(() => inPage<boolean>(c, "video.html", "document.getElementById('v').paused"))
      .toBe(true);
    const t0 = await inPage<number>(c, "video.html", "document.getElementById('v').currentTime");
    await bar.getByRole("button", { name: "Forward 10 s" }).click();
    await expect
      .poll(() => inPage<number>(c, "video.html", "document.getElementById('v').currentTime"))
      .toBeGreaterThanOrEqual(t0 + 9);
    await bar.getByRole("button", { name: /Captions off/ }).click();
    await expect
      .poll(() => inPage<string>(c, "video.html", "document.getElementById('v').textTracks[0].mode"))
      .toBe("showing");
    await bar.getByRole("button", { name: "Big screen" }).click();
    await expect(c.shell.getByRole("group", { name: "Big screen" })).toBeVisible();
    await c.shell.getByRole("button", { name: "Exit big screen" }).click();
    await expect(c.shell.getByRole("group", { name: "Big screen" })).toHaveCount(0);
  });

  test("Help and the Lifeline alert are never behind a page", async () => {
    await openPage(c, site.url("/article.html"));
    // The dock's Help and Stop sit outside the page's area.
    const view = await c.app.evaluate(() => {
      const b = (globalThis as any).__agency.browser;
      return [...b.tabs.values()].find((x: any) => x.id === b.activeId).view.getBounds();
    });
    for (const name of [/^Help:/, /^Stop agent$/]) {
      const r = (await c.shell.getByRole("button", { name }).first().boundingBox())!;
      const overlap =
        r.x < view.x + view.width &&
        view.x < r.x + r.width &&
        r.y < view.y + view.height &&
        view.y < r.y + r.height;
      expect(overlap, String(name)).toBe(false);
    }
    // An alert from anywhere hides the page at once (main's own call), and the emergency screen is on top.
    await c.shell.evaluate(() => window.agency.lifeline.help("help_button", true));
    await expect.poll(() => pageShowing(c)).toBe(false);
    await expect(
      c.shell.getByRole("alertdialog").or(c.shell.locator('[data-dwell-scope="modal"]')).first(),
    ).toBeVisible();
    // Even if the shell asks for the page now, it stays hidden while the alert is up.
    await c.app.evaluate(({ BrowserWindow }) => {
      const a = (globalThis as any).__agency;
      const shell = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith("agency://shell/"),
      )!;
      a.browser.layout(shell.webContents, { x: 200, y: 200, width: 800, height: 400 }, true);
    });
    expect(await pageShowing(c)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------
// The sandbox web world (os/sandbox-web), in its own process; its test API tells what really happened.

interface Sandbox {
  port: number;
  orders(): Promise<{ totalCents: number }[]>;
  reset(): Promise<void>;
  close(): void;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function startSandbox(): Promise<Sandbox> {
  const port = await freePort();
  const dir = join(repo, "os", "sandbox-web");
  const child = spawn(join(repo, "node_modules", ".bin", "tsx"), ["src/cli.ts", "--port", String(port)], {
    cwd: dir,
    stdio: "ignore",
  });
  const api = `http://127.0.0.1:${port}/__test`;
  await expect
    .poll(
      () =>
        fetch(`${api}/state`).then(
          (r) => r.ok,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  return {
    port,
    orders: async () =>
      ((await (await fetch(`${api}/state`)).json()) as { shop: { orders: { totalCents: number }[] } }).shop
        .orders,
    reset: async () => void (await fetch(`${api}/reset`, { method: "POST" })),
    close: () => void child.kill(),
  };
}

// ------------------------------------------------------------------------------------------------------------
// The assistant in AGENCY Browser: the real agent, its ordering pack and its guard, on the sandbox shop

test.describe("AGENCY's assistant in AGENCY Browser", () => {
  let c: Ctx;
  let sandbox: Sandbox;

  test.beforeAll(async () => {
    test.skip(!existsSync(realAgent), "os/agent is not built (npm run build -w @agency/agent)");
    test.skip(!existsSync(join(repo, "backend", ".venv", "bin", "python")), "needs backend/.venv");
    sandbox = await startSandbox();
    c = await launch({
      AGENCY_AGENT_ENTRY: realAgent,
      AGENCY_SANDBOX_PORT: String(sandbox.port),
      AGENCY_RELAY: "off",
      GEMINI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });
    await expect
      .poll(() => c.app.evaluate(() => (globalThis as any).__agency.states.agent as string), {
        timeout: 60_000,
      })
      .toBe("running");
  });
  test.afterEach(async ({}, info) => {
    // On a failure, what the panel said (the person's view), to tell an agent problem from a test problem.
    if (info.status !== info.expectedStatus) {
      const text = await c.shell
        .locator("body")
        .innerText()
        .catch(() => "(none)");
      writeFileSync(info.outputPath("shell.txt"), `${c.shell.url()}\n${text}`);
      await c.shell.screenshot({ path: info.outputPath("shell.png") }).catch(() => undefined);
    }
  });
  test.afterAll(async () => {
    await c?.app.close();
    sandbox?.close();
  });

  async function startOrder(id: string): Promise<void> {
    await c.shell.evaluate((t) => (location.hash = `/internet?task=${t}`), id);
    await expect(c.shell.locator(".bw")).toBeVisible();
    await c.shell.evaluate(
      (t) =>
        window.agency.agent.send({
          type: "task.start",
          request: {
            id: t,
            goal: "Buy paper towels on ShopMart",
            origin: "flow",
            dryRun: true,
            selections: {
              kind: "shopping",
              orderSite: "shopmart",
              orderQuery: "paper towels",
              browser: "agency",
              browserTab: "new",
            },
          },
        }),
      id,
    );
  }

  test("orders on the practice shop in AGENCY Browser, live, with the person's approval of the exact total", async () => {
    await sandbox.reset();
    await startOrder("order-1");
    const panel = c.shell.getByRole("complementary", { name: "Ask AGENCY" });
    await expect(panel).toContainText("Buy paper towels on ShopMart");
    // The pack asks which product, with real prices from the page.
    await expect(panel).toContainText("Which paper towels?", { timeout: 60_000 });
    await panel.getByRole("button", { name: /Sunny Day Paper Towels/ }).click();
    const approval = panel.getByTestId("browser-approval");
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(approval).toContainText("Practice site");
    await expect(approval).toContainText("$20.05");
    // The page the assistant works on is the shop, shown in AGENCY Browser.
    expect((await active(c)).url).toContain("shop.localhost");
    expect(await sandbox.orders()).toHaveLength(0);
    // For a person to look at (AGENCY_SHOT_DIR): the panel mid-task, asking for the OK.
    if (process.env.AGENCY_SHOT_DIR)
      await c.shell.screenshot({ path: join(process.env.AGENCY_SHOT_DIR, "14-agent-approval.png") });
    await approval.getByRole("button", { name: "Approve" }).click();
    const yes = approval.getByRole("button", { name: /Yes, pay/ });
    await expect(yes).toBeEnabled({ timeout: 5_000 });
    await yes.click();
    await expect(panel).toContainText("Done", { timeout: 60_000 });
    const orders = await sandbox.orders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.totalCents).toBe(2005);
  });

  test("Stop mid-task: nothing is bought, and the assistant does nothing more until a new task", async () => {
    await sandbox.reset();
    await startOrder("order-2");
    const panel = c.shell.getByRole("complementary", { name: "Ask AGENCY" });
    await expect(panel).toContainText("Which paper towels?", { timeout: 60_000 });
    await panel.getByRole("button", { name: /Sunny Day Paper Towels/ }).click();
    await expect(panel.getByTestId("browser-approval")).toBeVisible({ timeout: 60_000 });
    await c.shell.getByRole("button", { name: "Stop agent" }).click();
    await expect(panel).toContainText("Stopped", { timeout: 20_000 });
    expect(await sandbox.orders()).toHaveLength(0);
    const refused = await c.app.evaluate(async () => {
      try {
        await (globalThis as any).__agency.browser.agentCall("snapshot", {});
        return "answered";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(refused).toMatch(/pressed Stop/);
  });
});
