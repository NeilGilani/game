import type { Page, Route } from "@playwright/test";

export const PAGES = [
  "",
  "download/",
  "inside/",
  "setup/",
  "accessibility/",
  "privacy/",
  "credits/",
] as const;

const HEX = "3f".repeat(32);

export function makeRelease(opts: { body?: string; withDigest?: boolean } = {}) {
  const asset = (name: string, size: number) => ({
    name,
    size,
    url: `https://api.github.com/repos/NeilGilani/game/releases/assets/${name}`,
    browser_download_url: `https://github.com/NeilGilani/game/releases/download/v0.1.0/${name}`,
    content_type: "application/x-apple-diskimage",
    digest: opts.withDigest === false ? null : `sha256:${HEX}`,
  });
  return {
    tag_name: "v0.1.0",
    name: "AGENCY OS 0.1.0",
    published_at: "2026-10-09T12:00:00Z",
    html_url: "https://github.com/NeilGilani/game/releases/tag/v0.1.0",
    body: opts.body ?? "",
    prerelease: false,
    assets: [asset("AGENCY-0.1.0-arm64.dmg", 187_400_000), asset("AGENCY-0.1.0-x64.dmg", 192_100_000)],
  };
}
export const SHA = HEX;

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "offline";

/** Stand in for GitHub's API so tests never touch the network and can show every state. */
export async function mockGitHub(
  page: Page,
  latest: Answer,
  repo: Answer = { status: 200, body: {} },
): Promise<void> {
  const reply = (answer: Answer) => (route: Route) =>
    answer === "offline"
      ? route.abort("internetdisconnected")
      : route.fulfill({
          status: answer.status,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": "*",
            // GitHub exposes its rate-limit headers to pages, like this.
            "access-control-expose-headers": "X-RateLimit-Remaining, X-RateLimit-Reset",
            ...(answer.headers ?? {}),
          },
          body: JSON.stringify(answer.body ?? { message: "Not Found" }),
        });
  await page.route("https://api.github.com/repos/*/*/releases/latest", reply(latest));
  await page.route("https://api.github.com/repos/*/*", reply(repo));
}

/** Pretend to be a particular computer: Chrome's client hints and the user agent. */
export async function pretend(
  page: Page,
  os: "macOS" | "Windows",
  architecture: "arm" | "x86" | "",
): Promise<void> {
  await page.addInitScript(
    ([platform, arch]) => {
      const ua =
        platform === "Windows"
          ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
      Object.defineProperty(navigator, "userAgent", { get: () => ua });
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
      Object.defineProperty(navigator, "userAgentData", {
        get: () => ({
          platform,
          getHighEntropyValues: async () => ({ platform, architecture: arch, bitness: "64" }),
        }),
      });
      // Hide the real GPU so only the client hints decide.
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        return type === "webgl" ? null : (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    },
    [os, architecture] as const,
  );
}
