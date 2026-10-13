/** AGENCY Browser's rules in main: navigation, requests, permissions, downloads, ad blocking, settings, IPC checks. */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBlockedAd, siteOf } from "../src/main/browser/adblock";
import {
  ANY_SITE,
  AGENT_DEFAULT_SITES,
  withWebSettings,
  writeWebSettings,
} from "../src/main/browser/agentweb";
import { parseReply } from "../src/main/browser/channel";
import { fieldOp, rect, scrollRequest, tabId } from "../src/main/browser/ipc";
import {
  blockedLinkReason,
  checkPermission,
  chromeUserAgent,
  decideNavigation,
  decideRequest,
  isInternal,
  isLocalHost,
  isProgram,
  loadError,
  routePermission,
  safeFilename,
  securityOf,
  sensitiveKind,
  uniqueName,
} from "../src/main/browser/policy";
import { BrowserStore, DEFAULT_FAVOURITES, parseFavourites, parseSettings } from "../src/main/browser/store";

const INTERNAL = ["http://127.0.0.1:8765", "http://localhost:5173"];

describe("navigation", () => {
  it("opens http and https pages, canonically", () => {
    expect(decideNavigation("https://Example.org/a?b=1", INTERNAL)).toEqual({
      ok: true,
      url: "https://example.org/a?b=1",
      security: "secure",
    });
    expect(decideNavigation("http://news.example.com/", INTERNAL)).toMatchObject({
      ok: true,
      security: "insecure",
    });
    expect(decideNavigation("http://shop.localhost:8787/", INTERNAL)).toMatchObject({
      ok: true,
      security: "local",
    });
  });

  it("blocks files, browser and developer pages, scripts and data", () => {
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "chrome-extension://abc/page.html",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://example.org",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.org/123",
      "filesystem:https://example.org/temporary/x",
      "ftp://files.example.org/",
      "not a url",
    ])
      expect(decideNavigation(url, INTERNAL).ok, url).toBe(false);
  });

  it("never opens AGENCY itself: agency://, the coordinator (any loopback spelling) or the dev shell", () => {
    expect(decideNavigation("agency://shell/", INTERNAL)).toMatchObject({ ok: false, kind: "internal" });
    expect(decideNavigation("http://127.0.0.1:8765/api/lifeline/status", INTERNAL)).toMatchObject({
      ok: false,
      kind: "internal",
    });
    expect(decideNavigation("http://localhost:8765/respond/x", INTERNAL)).toMatchObject({ ok: false });
    expect(decideNavigation("http://[::1]:8765/", INTERNAL)).toMatchObject({ ok: false });
    expect(decideNavigation("http://127.0.0.2:8765/", INTERNAL)).toMatchObject({ ok: false });
    expect(decideNavigation("http://localhost:5173/#/settings", INTERNAL)).toMatchObject({ ok: false });
    // Another port on this computer, and the sandbox sites, are fine.
    expect(decideNavigation("http://127.0.0.1:9999/", INTERNAL).ok).toBe(true);
    expect(decideNavigation("http://food.localhost:8787/", INTERNAL).ok).toBe(true);
  });

  it("refuses addresses that hide a user name or password", () => {
    expect(decideNavigation("https://bank.example@evil.example/", INTERNAL)).toMatchObject({
      ok: false,
      kind: "credentials",
    });
  });

  it("knows this computer, and what is secure", () => {
    for (const h of ["localhost", "shop.localhost", "127.0.0.1", "[::1]", "::1"])
      expect(isLocalHost(h), h).toBe(true);
    for (const h of ["localhost.example.com", "example.org", "10.0.0.1"])
      expect(isLocalHost(h), h).toBe(false);
    expect(securityOf(new URL("https://a.example"))).toBe("secure");
    expect(securityOf(new URL("http://a.example"))).toBe("insecure");
    expect(isInternal(new URL("http://localhost:8765/"), ["http://127.0.0.1:8765"])).toBe(true);
    expect(isInternal(new URL("https://127.0.0.1:8765/"), ["http://127.0.0.1:8765"])).toBe(false);
  });

  it("lets pages load the web but never reach AGENCY's services, even in the background", () => {
    expect(decideRequest("https://cdn.example.org/app.js", INTERNAL)).toBe(true);
    expect(decideRequest("wss://chat.example.org/socket", INTERNAL)).toBe(true);
    expect(decideRequest("data:image/png;base64,AAAA", INTERNAL)).toBe(true);
    expect(decideRequest("http://127.0.0.1:8765/api/lifeline/help", INTERNAL)).toBe(false);
    expect(decideRequest("ws://localhost:8765/", INTERNAL)).toBe(false);
    expect(decideRequest("file:///etc/passwd", INTERNAL)).toBe(false);
    expect(decideRequest("agency://shell/index.html", INTERNAL)).toBe(false);
  });

  it("says why a page didn't load, plainly", () => {
    expect(loadError(-3)).toBeNull();
    expect(loadError(-202)?.kind).toBe("certificate");
    expect(loadError(-105)?.message).toMatch(/couldn't find that site/);
    expect(loadError(-106)?.message).toMatch(/isn't connected/);
    expect(loadError(-20)?.kind).toBe("blocked");
    expect(loadError(-999)?.kind).toBe("load");
  });

  it("presents as Chrome, without Electron or AGENCY in the user agent", () => {
    const ua =
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) AGENCY/0.1.0 Chrome/140.0 Electron/44.4.5 Safari/537.36";
    expect(chromeUserAgent(ua)).toBe(
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    );
  });
});

describe("sensitive sites (the assistant only reads there)", () => {
  it("finds banks, password managers, account security, health records and government", () => {
    expect(sensitiveKind("https://www.chase.com/")).toBe("bank");
    expect(sensitiveKind("http://bank.localhost:8787/")).toBe("bank");
    expect(sensitiveKind("https://my.1password.com/")).toBe("passwords");
    expect(sensitiveKind("https://accounts.google.com/signin")).toBe("account");
    expect(sensitiveKind("https://mychart.example-health.org/")).toBe("health");
    expect(sensitiveKind("https://www.nhs.uk/")).toBe("health");
    expect(sensitiveKind("https://www.irs.gov/")).toBe("government");
    expect(sensitiveKind("https://www.gov.uk/")).toBe("government");
    expect(sensitiveKind("https://www.canada.ca/en.html")).toBe("government");
  });
  it("leaves ordinary sites alone", () => {
    for (const u of [
      "https://www.wikipedia.org/",
      "https://www.youtube.com/",
      "https://www.governance.example/",
      "https://healthline.com/",
    ])
      expect(sensitiveKind(u), u).toBeNull();
  });
});

describe("permissions", () => {
  it("never gives a page the camera; asks per site for microphone, location, notifications, clipboard", () => {
    expect(routePermission("media", ["video"])).toEqual({ kind: "deny", why: "camera" });
    expect(routePermission("media", ["audio", "video"])).toEqual({ kind: "deny", why: "camera" });
    expect(routePermission("media", [])).toEqual({ kind: "deny", why: "camera" });
    expect(routePermission("media", ["audio"])).toEqual({ kind: "ask", permission: "microphone" });
    expect(routePermission("geolocation", undefined)).toEqual({ kind: "ask", permission: "location" });
    expect(routePermission("notifications", undefined)).toEqual({ kind: "ask", permission: "notifications" });
    expect(routePermission("clipboard-read", undefined)).toEqual({ kind: "ask", permission: "clipboard" });
  });
  it("denies devices, screen capture, other windows and opening apps; allows full screen and copy", () => {
    for (const p of [
      "midi",
      "midiSysex",
      "pointerLock",
      "openExternal",
      "display-capture",
      "window-management",
      "hid",
      "serial",
      "usb",
      "idle-detection",
      "unknown",
    ])
      expect(routePermission(p, undefined).kind, p).toBe("deny");
    expect(routePermission("fullscreen", undefined).kind).toBe("allow");
    expect(routePermission("clipboard-sanitized-write", undefined).kind).toBe("allow");
  });
  it("checks only what the person allowed before", () => {
    const stored = (p: string) => (p === "location" ? "allow" : p === "notifications" ? "deny" : null);
    expect(checkPermission("geolocation", undefined, stored as never)).toBe(true);
    expect(checkPermission("notifications", undefined, stored as never)).toBe(false);
    expect(checkPermission("clipboard-read", undefined, stored as never)).toBe(false);
    expect(checkPermission("media", "video", () => "allow")).toBe(false);
  });
});

describe("downloads", () => {
  it("keeps plain, unique names and flags programs", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename(".bashrc")).toBe("bashrc");
    expect(safeFilename("a:b*c?.pdf")).toBe("a_b_c_.pdf");
    expect(safeFilename("")).toBe("download");
    expect(safeFilename(`${"x".repeat(300)}.pdf`)).toMatch(/^x+\.pdf$/);
    expect(safeFilename(`${"x".repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
    const taken = new Set(["list.txt", "list (2).txt"]);
    expect(uniqueName("list.txt", (n) => taken.has(n))).toBe("list (3).txt");
    expect(uniqueName("new.txt", (n) => taken.has(n))).toBe("new.txt");
    for (const n of ["setup.dmg", "Installer.PKG", "run.command", "x.app", "script.sh", "evil.exe"])
      expect(isProgram(n), n).toBe(true);
    for (const n of ["photo.jpg", "letter.pdf", "list.txt"]) expect(isProgram(n), n).toBe(false);
  });
});

describe("ad blocking", () => {
  it("blocks listed hosts only as a third party, never the page itself", () => {
    expect(
      isBlockedAd("https://securepubads.g.doubleclick.net/tag.js", "https://news.example.com/", "script"),
    ).toBe(true);
    expect(
      isBlockedAd("https://www.googletagmanager.com/gtm.js", "https://news.example.com/", "script"),
    ).toBe(false);
    expect(isBlockedAd("https://ad.doubleclick.net/x", "https://news.example.com/", "mainFrame")).toBe(false);
    expect(isBlockedAd("https://cdn.taboola.com/x.js", "https://www.taboola.com/", "script")).toBe(false);
    expect(isBlockedAd("https://news.example.com/ads.js", "https://news.example.com/", "script")).toBe(false);
    expect(siteOf("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("a.b.example.com")).toBe("example.com");
  });
});

describe("the browser's own store", () => {
  it("starts with the default sites and settings, and checks everything it is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-bstore-"));
    const s = new BrowserStore(dir);
    expect(s.favourites.map((f) => f.title)).toEqual(DEFAULT_FAVOURITES.map((f) => f.title));
    expect(s.settings).toMatchObject({
      searchEngine: "google",
      blockAds: true,
      agentAnySite: true,
      realActions: false,
    });
    expect(s.setSettings({ searchEngine: "nope", realActions: "yes", blockAds: false }).blockAds).toBe(false);
    expect(s.settings.searchEngine).toBe("google");
    expect(s.settings.realActions).toBe(false);
    const favs = s.setFavourites(
      [
        { title: "Blog", url: "https://blog.example.org" },
        { title: "Same", url: "https://blog.example.org/" },
        { title: "File", url: "file:///etc/passwd" },
        { title: "Coordinator", url: "http://127.0.0.1:8765/" },
        { title: "", url: "https://x.example" },
        { url: "https://y.example" },
      ],
      INTERNAL,
    );
    expect(favs.map((f) => f.url)).toEqual(["https://blog.example.org/"]);
    // Files are private to this Mac user.
    expect(statSync(join(dir, "browser.json")).mode & 0o077).toBe(0);
    // Reloaded from disk.
    expect(new BrowserStore(dir).favourites.map((f) => f.title)).toEqual(["Blog"]);
  });

  it("keeps per-site answers, never an allowed camera", () => {
    const s = new BrowserStore(mkdtempSync(join(tmpdir(), "agency-bstore-")));
    s.setPermission("https://maps.example", "location", "allow");
    s.setPermission("https://maps.example", "camera", "allow");
    expect(s.permission("https://maps.example", "location")).toBe("allow");
    expect(s.permission("https://maps.example", "camera")).toBeNull();
    s.forgetPermission("https://maps.example", "location");
    expect(s.permission("https://maps.example", "location")).toBeNull();
  });

  it("keeps history local and bounded, newest first, and clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-bstore-"));
    const s = new BrowserStore(dir);
    s.addHistory("https://a.example/", "A", 1);
    s.addHistory("https://b.example/", "B", 2);
    s.addHistory("https://a.example/", "A again", 3);
    s.addHistory("file:///etc/passwd", "no", 4);
    expect(s.history.map((h) => h.url)).toEqual(["https://a.example/", "https://b.example/"]);
    s.titleHistory("https://b.example/", "Bee");
    s.flush();
    expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8"))[1].title).toBe("Bee");
    s.clearHistory();
    expect(s.history).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8"))).toEqual([]);
  });

  it("parses settings and favourites defensively", () => {
    expect(parseSettings(null)).toMatchObject({ agentBrowser: "agency" });
    expect(parseSettings({ agentBrowser: "chrome" }).agentBrowser).toBe("chrome");
    expect(parseFavourites("nope")).toEqual([]);
    expect(
      parseFavourites(
        Array.from({ length: 60 }, (_, i) => ({ title: `S${i}`, url: `https://s${i}.example` })),
      ).length,
    ).toBe(24);
  });
});

describe("the assistant's web limits, written for the agent's guard", () => {
  it("adds 'any website' to the guard's list and turns simulated-only off only for real actions", () => {
    const on = withWebSettings({}, { agentAnySite: true, realActions: false });
    expect(on.siteAllowlist).toEqual([...AGENT_DEFAULT_SITES, ...ANY_SITE]);
    expect(on.simulatedOnly).toBe(true);
    const off = withWebSettings(on, { agentAnySite: false, realActions: true });
    expect(off.siteAllowlist).toEqual(AGENT_DEFAULT_SITES);
    expect(off.simulatedOnly).toBe(false);
  });
  it("keeps a caregiver's own sites and limits", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agency-aweb-")), "agent-settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        siteAllowlist: ["https://pharmacy.example"],
        maxPurchase: 20,
        realOrdering: { enabled: true, maxOrder: 40 },
      }),
    );
    writeWebSettings(file, { agentAnySite: true, realActions: false });
    const v = JSON.parse(readFileSync(file, "utf8"));
    expect(v).toMatchObject({
      maxPurchase: 20,
      realOrdering: { enabled: true, maxOrder: 40 },
      simulatedOnly: true,
    });
    expect(v.siteAllowlist).toEqual(["https://pharmacy.example", ...ANY_SITE]);
    expect(statSync(file).mode & 0o077).toBe(0);
  });
});

describe("checking the shell's calls and pages' replies", () => {
  it("accepts only well-formed arguments", () => {
    expect(tabId(3)).toBe(3);
    for (const bad of [0, -1, 1.5, "3", null, undefined]) expect(() => tabId(bad)).toThrow();
    expect(rect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(rect({ x: 1, y: 2, width: Infinity, height: 4 })).toBeNull();
    expect(rect("x")).toBeNull();
    expect(fieldOp({ op: "set", value: "x".repeat(9000) })).toEqual({ op: "set", value: "x".repeat(5000) });
    expect(fieldOp({ op: "submit", confirmed: "yes" })).toEqual({ op: "submit", confirmed: false });
    expect(() => fieldOp({ op: "eval" })).toThrow();
    expect(scrollRequest({ by: "px", amount: 1e9 })).toEqual({ by: "px", amount: 4000 });
    expect(scrollRequest({ by: "page", direction: -1 })).toEqual({ by: "page", direction: -1 });
    expect(() => scrollRequest({ by: "px", amount: "1" })).toThrow();
  });
  it("reads a page's reply only if it is one, and bounds its words", () => {
    expect(parseReply({ id: 1, ok: true, result: 5 })).toEqual({ id: 1, ok: true, result: 5 });
    expect(parseReply({ id: "1", ok: true })).toBeNull();
    expect(parseReply({ id: 1.5, ok: true })).toBeNull();
    expect(parseReply(null)).toBeNull();
    expect(parseReply({ id: 2, ok: false, error: "e".repeat(1000) })?.error?.length).toBe(300);
  });
});

describe("links Chromium refuses without a word", () => {
  it("say why for files and browser pages, and leave every other link to the page", () => {
    expect(blockedLinkReason("file:///etc/hosts")).toBe(
      "Files on this computer can't be opened in AGENCY Browser.",
    );
    expect(blockedLinkReason("chrome://settings")).toMatch(/off limits/);
    expect(blockedLinkReason("https://example.com/")).toBeNull();
    expect(blockedLinkReason("javascript:void(0)")).toBeNull();
    expect(blockedLinkReason("mailto:a@b.c")).toBeNull();
    expect(blockedLinkReason("not a url")).toBeNull();
  });
});
