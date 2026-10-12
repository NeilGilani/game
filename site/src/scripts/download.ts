// The download panel: asks GitHub for the latest release and shows the right .dmg for this Mac, with its version,
// date, size and SHA-256. The static HTML inside the panel (a link to the releases page) is what people without
// JavaScript get, and what everyone gets if anything here fails.
import { detectPlatform, type Platform, type PlatformInputs } from "../lib/platform";
import {
  chooseDmg,
  findDmgs,
  findSha256,
  formatBytes,
  formatDate,
  isUnsigned,
  kindLabel,
  loadLatestRelease,
  type Fetcher,
  type GitHubAsset,
  type GitHubRelease,
  type ReleaseState,
} from "../lib/release";

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

async function readPlatform(): Promise<Platform> {
  const nav = navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<Record<string, string>> };
  };
  const inputs: PlatformInputs = {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
  };
  try {
    if (nav.userAgentData)
      inputs.clientHints = await nav.userAgentData.getHighEntropyValues(["architecture", "bitness"]);
  } catch {
    /* not offered: fall back to the graphics chip */
  }
  if (!inputs.clientHints?.architecture) {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      if (gl && ext) inputs.webglRenderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch {
      /* no WebGL */
    }
  }
  return detectPlatform(inputs);
}

const fetcher: Fetcher = (url, init) =>
  fetch(url, { ...init, cache: "no-store", referrerPolicy: "no-referrer" });

async function fetchText(apiUrl: string): Promise<string | null> {
  // The asset's API URL returns the file itself with this header. GitHub may refuse it cross-origin; then we
  // simply show the link to the SHA256SUMS file instead.
  const res = await fetch(apiUrl, {
    headers: { Accept: "application/octet-stream" },
    referrerPolicy: "no-referrer",
  });
  return res.ok ? res.text() : null;
}

interface Ctx {
  panel: HTMLElement;
  repo: string;
  releasesUrl: string;
  contactHref: string;
  contactLabel: string;
  base: string;
}

function setPanel(ctx: Ctx, ...children: Child[]): void {
  ctx.panel.replaceChildren(...children.filter((c): c is Node | string => !!c));
}

function releasesButton(ctx: Ctx, label = "Open the releases page on GitHub"): HTMLElement {
  return h("a", { class: "btn", href: ctx.releasesUrl }, label);
}

function otherPlatforms(ctx: Ctx, os: Platform["os"]): HTMLElement {
  const name =
    os === "windows"
      ? "Windows"
      : os === "linux"
        ? "Linux"
        : os === "ios"
          ? "iPhone and iPad"
          : os === "android"
            ? "Android"
            : os === "chromeos"
              ? "ChromeOS"
              : "this computer";
  return h(
    "div",
    { class: "dl-other" },
    h("h3", {}, `The AGENCY app for ${name}: not yet`),
    h(
      "p",
      {},
      "The AGENCY app runs on a Mac for now, because it relies on macOS accessibility features to control every app. You can still try AGENCY in your browser. If you'd use the app on ",
      name,
      ", tell us and we'll write back when that changes.",
    ),
    h("div", { class: "actions" }, h("a", { class: "btn", href: ctx.contactHref }, ctx.contactLabel)),
    h(
      "p",
      { class: "dl-small" },
      "Setting it up for someone else's Mac? You can download the Mac app on any computer and copy it to their Mac.",
    ),
  );
}

function shaBlock(release: GitHubRelease, asset: GitHubAsset): HTMLElement {
  const dd = h("dd", { "data-sha": asset.name }, "Looking it up…");
  const block = h("div", {}, h("dt", {}, "SHA-256"), dd);
  void findSha256(release, asset, fetchText).then((found) => {
    if (found) {
      dd.replaceChildren(h("code", { class: "sha" }, found.sha256));
      return;
    }
    const sums = release.assets.find((a) => /^(sha256sums|checksums)(\.txt)?$/i.test(a.name));
    dd.replaceChildren(
      sums
        ? h(
            "span",
            {},
            "Listed in ",
            h("a", { href: sums.browser_download_url }, sums.name),
            " in this release.",
          )
        : "Not published with this release.",
    );
  });
  return block;
}

function renderRelease(ctx: Ctx, release: GitHubRelease, platform: Platform): void {
  const dmgs = findDmgs(release.assets);
  const arch = platform.os === "mac" ? platform.arch : "unknown";
  const choice = chooseDmg(dmgs, arch);
  const version = release.tag_name;
  const unsigned = isUnsigned(release);

  if (!choice.primary) {
    setPanel(
      ctx,
      h("h3", {}, `${release.name || version} has no Mac installer attached`),
      h(
        "p",
        {},
        "The latest release doesn't include a .dmg file yet. The releases page has everything it does include.",
      ),
      h("div", { class: "actions" }, releasesButton(ctx)),
    );
    return;
  }

  const { asset, kind } = choice.primary;
  const reason =
    platform.os !== "mac"
      ? "You're not on a Mac right now, so here is the version for Apple silicon Macs. Pick Intel below for an older Mac."
      : kind === "universal"
        ? "This version works on every supported Mac."
        : choice.guessed
          ? "We couldn't tell which chip this Mac has, so this is the Apple silicon version. Not sure? See “Which Mac do I have?” below."
          : `This Mac appears to have ${kind === "arm64" ? "Apple silicon" : "an Intel processor"}, so this is the matching version.`;

  const details = h(
    "dl",
    { class: "dl-facts" },
    h("div", {}, h("dt", {}, "Version"), h("dd", {}, version)),
    h("div", {}, h("dt", {}, "Released"), h("dd", {}, formatDate(release.published_at))),
    h("div", {}, h("dt", {}, "Size"), h("dd", {}, formatBytes(asset.size))),
    h("div", {}, h("dt", {}, "File"), h("dd", {}, h("code", {}, asset.name))),
    shaBlock(release, asset),
  );

  const others = choice.others.map((o) =>
    h(
      "a",
      { class: "btn btn-secondary btn-stack", href: o.asset.browser_download_url, "data-kind": o.kind },
      `Download for ${kindLabel(o.kind)}`,
      h("span", { class: "sub" }, `${o.asset.name}, ${formatBytes(o.asset.size)}`),
    ),
  );

  setPanel(
    ctx,
    h(
      "p",
      { class: "dl-status" },
      release.prerelease ? "Latest test version (pre-release)" : "Latest version",
      unsigned ? " · not signed by Apple yet" : "",
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "a",
        {
          class: "btn btn-primary btn-stack dl-primary",
          href: asset.browser_download_url,
          "data-kind": kind,
        },
        `Download for ${kindLabel(kind)}`,
        h("span", { class: "sub" }, `${version} · ${formatBytes(asset.size)} · .dmg`),
      ),
      ...others,
    ),
    h("p", { class: "dl-reason" }, reason),
    details,
    unsigned
      ? h(
          "div",
          { class: "note" },
          h(
            "p",
            {},
            h("strong", {}, "This build isn't signed by Apple yet."),
            " The first time, macOS will refuse to open it. ",
          ),
          h("p", {}, h("a", { href: "#unsigned" }, "The exact steps to open it anyway"), " are just below."),
        )
      : null,
    h(
      "p",
      { class: "dl-small" },
      "Release notes and older versions: ",
      h("a", { href: release.html_url }, `${version} on GitHub`),
      ".",
    ),
    platform.os !== "mac" ? otherPlatforms(ctx, platform.os) : null,
  );
  ctx.panel.dataset["state"] = "ok";
  if (unsigned) document.querySelector<HTMLDetailsElement>("#unsigned")?.setAttribute("open", "");
}

function renderProblem(ctx: Ctx, state: Exclude<ReleaseState, { kind: "ok" }>, platform: Platform): void {
  ctx.panel.dataset["state"] = state.kind;
  const other = platform.os !== "mac" ? otherPlatforms(ctx, platform.os) : null;
  switch (state.kind) {
    case "no-release":
      setPanel(
        ctx,
        h("h3", {}, "The first Mac release isn't out yet"),
        h(
          "p",
          {},
          "AGENCY is being built in the open, and the first Mac version is on its way. When it's ready, it will appear here with its size and checksum, and on the releases page.",
        ),
        h(
          "p",
          {},
          "Today you can ",
          h("a", { href: `${ctx.base}app/` }, "try AGENCY in your browser"),
          ", with nothing to install, or ",
          h("a", { href: "#build" }, "build the Mac app yourself"),
          " from the source code.",
        ),
        h("div", { class: "actions" }, releasesButton(ctx, "Watch the releases page")),
        other,
      );
      return;
    case "private-or-missing":
      setPanel(
        ctx,
        h("h3", {}, "Downloads aren't public yet"),
        h(
          "p",
          {},
          `GitHub doesn't show releases of ${ctx.repo} to visitors who aren't signed in, so the installer can't be downloaded from this page. That usually means the repository is private.`,
        ),
        h(
          "p",
          {},
          "If you have access, sign in to GitHub and open the releases page. If you run this project, there are two ways to fix it:",
        ),
        h(
          "ol",
          {},
          h("li", {}, "Make the repository public, or"),
          h(
            "li",
            {},
            "Keep the code private and publish the .dmg files to a separate public repository used only for releases, then build this site with PUBLIC_RELEASES_REPO set to it (see site/README.md).",
          ),
        ),
        h("div", { class: "actions" }, releasesButton(ctx, "Open the releases page (needs access)")),
        other,
      );
      return;
    case "rate-limited":
      setPanel(
        ctx,
        h("h3", {}, "GitHub asked us to slow down"),
        h(
          "p",
          {},
          "GitHub limits how often a page can ask it about releases. The releases page always works.",
          state.resetAt ? ` This page can check again after ${state.resetAt.toLocaleTimeString()}.` : "",
        ),
        h("div", { class: "actions" }, releasesButton(ctx)),
        other,
      );
      return;
    case "error":
      setPanel(
        ctx,
        h("h3", {}, "We couldn't check for the latest version"),
        h("p", {}, state.detail, " The releases page on GitHub has every version."),
        h("div", { class: "actions" }, releasesButton(ctx)),
        other,
      );
      return;
  }
}

export async function initDownload(): Promise<void> {
  const panel = document.querySelector<HTMLElement>("#download-panel");
  if (!panel) return;
  const ctx: Ctx = {
    panel,
    repo: panel.dataset["repo"] ?? "",
    releasesUrl: panel.dataset["releasesUrl"] ?? "",
    contactHref: panel.dataset["contactHref"] ?? "",
    contactLabel: panel.dataset["contactLabel"] ?? "Tell us",
    base: panel.dataset["base"] ?? "/",
  };
  panel.setAttribute("aria-busy", "true");
  const [platform, state] = await Promise.all([readPlatform(), loadLatestRelease(ctx.repo, fetcher)]);
  if (state.kind === "ok") renderRelease(ctx, state.release, platform);
  else renderProblem(ctx, state, platform);
  panel.setAttribute("aria-busy", "false");
}
