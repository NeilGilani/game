// The download panel against a stand-in GitHub API, in every state it can be in.
import { expect, test } from "@playwright/test";
import { SHA, makeRelease, mockGitHub, pretend } from "./fixtures";

const panel = (page: import("@playwright/test").Page) => page.locator("#download-panel");

test.beforeEach(({}, info) =>
  test.skip(info.project.name !== "desktop", "platform is faked; one project is enough"),
);

test("offers the Apple silicon build on an Apple silicon Mac, with version, date, size and SHA-256", async ({
  page,
}) => {
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, { status: 200, body: makeRelease() });
  await page.goto("#download");
  const primary = panel(page).locator(".dl-primary");
  await expect(primary).toContainText("Download for Apple silicon");
  await expect(primary).toHaveAttribute("href", /AGENCY-0\.1\.0-arm64\.dmg$/);
  await expect(panel(page)).toContainText("v0.1.0");
  await expect(panel(page)).toContainText("9 October 2026");
  await expect(panel(page)).toContainText("187 MB");
  await expect(panel(page).locator(".sha")).toHaveText(SHA);
  await expect(panel(page).getByRole("link", { name: /Download for Intel/ })).toHaveAttribute(
    "href",
    /x64\.dmg$/,
  );
  await expect(panel(page)).toContainText("appears to have Apple silicon");
  await expect(panel(page)).not.toContainText("isn't signed");
});

test("offers the Intel build on an Intel Mac", async ({ page }) => {
  await pretend(page, "macOS", "x86");
  await mockGitHub(page, { status: 200, body: makeRelease() });
  await page.goto("#download");
  await expect(panel(page).locator(".dl-primary")).toHaveAttribute("href", /x64\.dmg$/);
});

test("says it guessed when it can't tell the chip", async ({ page }) => {
  await pretend(page, "macOS", "");
  await mockGitHub(page, { status: 200, body: makeRelease() });
  await page.goto("#download");
  await expect(panel(page).locator(".dl-primary")).toHaveAttribute("href", /arm64\.dmg$/);
  await expect(panel(page)).toContainText("couldn't tell which chip");
});

test("an unsigned build shows the steps to open it, already expanded", async ({ page }) => {
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, {
    status: 200,
    body: makeRelease({ body: "Unsigned build. <!-- agency:unsigned -->" }),
  });
  await page.goto("#download");
  await expect(panel(page)).toContainText("isn't signed by Apple yet");
  await expect(page.locator("#unsigned")).toHaveAttribute("open", "");
  await expect(page.locator("#unsigned")).toContainText("Open Anyway");
});

test("without GitHub's digest or a SHA256SUMS file, it says the checksum wasn't published", async ({
  page,
}) => {
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, { status: 200, body: makeRelease({ withDigest: false }) });
  await page.goto("#download");
  await expect(panel(page)).toContainText("Not published with this release.");
});

test("before the first release, it says so and links to the releases page", async ({ page }) => {
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, { status: 404 }, { status: 200, body: { private: false } });
  await page.goto("#download");
  await expect(panel(page)).toHaveAttribute("data-state", "no-release");
  await expect(panel(page).getByRole("heading")).toHaveText("The first Mac release isn't out yet");
  await expect(panel(page).getByRole("link", { name: "Watch the releases page" })).toHaveAttribute(
    "href",
    "https://github.com/NeilGilani/game/releases",
  );
});

test("a private repository is explained, with the two ways to fix it", async ({ page }) => {
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, { status: 404 }, { status: 404 });
  await page.goto("#download");
  await expect(panel(page)).toHaveAttribute("data-state", "private-or-missing");
  await expect(panel(page)).toContainText("Make the repository public");
  await expect(panel(page)).toContainText("separate public repository");
});

test("GitHub's rate limit falls back to the releases page", async ({ page }) => {
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791676800" },
  });
  await page.goto("#download");
  await expect(panel(page)).toHaveAttribute("data-state", "rate-limited");
  await expect(panel(page).getByRole("link", { name: "Open the releases page on GitHub" })).toBeVisible();
});

test("offline falls back to the releases page", async ({ page }) => {
  await pretend(page, "macOS", "arm");
  await mockGitHub(page, "offline");
  await page.goto("#download");
  await expect(panel(page)).toHaveAttribute("data-state", "error");
  await expect(panel(page)).toContainText("couldn't reach GitHub");
});

test("Windows visitors hear 'not yet', with a way to tell us and no third-party form", async ({ page }) => {
  await pretend(page, "Windows", "x86");
  await mockGitHub(page, { status: 200, body: makeRelease() });
  await page.goto("#download");
  await expect(panel(page)).toContainText("AGENCY OS for Windows: not yet");
  const tell = panel(page).locator(".dl-other a");
  await expect(tell).toHaveAttribute("href", /^(mailto:|https:\/\/github\.com\/NeilGilani\/game\/issues)/);
  await expect(page.locator("form")).toHaveCount(0);
});

test("without JavaScript, the panel is a working link to the releases page", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4329/game/#download");
  await expect(panel(page).getByRole("link", { name: "Open the releases page on GitHub" })).toBeVisible();
  await context.close();
});
