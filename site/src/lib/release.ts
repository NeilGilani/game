// Pure logic for the download panel: reading a GitHub release, choosing the right .dmg and describing what the
// visitor should see. No DOM and no network here, so all of it is unit-tested (tests/unit/release.test.ts).

export type Arch = "arm64" | "x64";
export type DmgKind = Arch | "universal";

export interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** The API URL of the asset; with `Accept: application/octet-stream` it returns the file itself. */
  url: string;
  content_type?: string;
  /** GitHub fills this in for assets uploaded since mid-2025, e.g. "sha256:9f86d0...". */
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  body: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets: GitHubAsset[];
}

export interface Dmgs {
  arm64?: GitHubAsset;
  x64?: GitHubAsset;
  universal?: GitHubAsset;
}

/** Which Mac a .dmg is for, from its file name. electron-builder names an Intel build without a suffix. */
export function classifyDmg(name: string): DmgKind | "unmarked" | null {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".dmg")) return null;
  if (/universal/.test(lower)) return "universal";
  if (/(arm64|aarch64|apple[-_ ]?silicon)/.test(lower)) return "arm64";
  if (/(x64|x86[-_]?64|intel|amd64)/.test(lower)) return "x64";
  return "unmarked";
}

export function findDmgs(assets: readonly GitHubAsset[]): Dmgs {
  const found: Dmgs = {};
  const unmarked: GitHubAsset[] = [];
  for (const asset of assets) {
    const kind = classifyDmg(asset.name);
    if (kind === null) continue;
    if (kind === "unmarked") unmarked.push(asset);
    else found[kind] ??= asset;
  }
  // electron-builder's default: "AGENCY-1.0.0.dmg" (Intel) next to "AGENCY-1.0.0-arm64.dmg".
  // A lone unmarked .dmg is not guessed at: we can't know which Mac it's for, so it's offered as "universal"
  // only if nothing else exists, and the panel says it couldn't tell.
  const first = unmarked[0];
  if (first !== undefined) {
    if (found.arm64 && !found.x64) found.x64 = first;
    else if (!found.arm64 && !found.x64 && !found.universal) found.universal = first;
  }
  return found;
}

export interface Choice {
  /** The download we recommend, or undefined when the release has no .dmg at all. */
  primary?: { asset: GitHubAsset; kind: DmgKind } | undefined;
  /** Other .dmg files the visitor can pick instead. */
  others: { asset: GitHubAsset; kind: DmgKind }[];
  /** True when we recommended a file without knowing which Mac the visitor has. */
  guessed: boolean;
}

export function chooseDmg(dmgs: Dmgs, arch: Arch | "unknown"): Choice {
  const all = (["arm64", "x64", "universal"] as const)
    .map((kind) => ({ kind, asset: dmgs[kind] }))
    .filter((x): x is { kind: DmgKind; asset: GitHubAsset } => x.asset !== undefined);
  if (all.length === 0) return { others: [], guessed: false };

  let primary = arch === "unknown" ? undefined : all.find((x) => x.kind === arch);
  primary ??= all.find((x) => x.kind === "universal");
  // Unknown Mac and no universal build: recommend Apple silicon (every Mac sold since 2023), but say we guessed.
  primary ??= all.find((x) => x.kind === "arm64") ?? all[0];
  const guessed = arch === "unknown" && primary?.kind !== "universal";
  return { primary, others: all.filter((x) => x !== primary), guessed };
}

export function sha256FromDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** Parse `shasum -a 256` / `sha256sum` output: "<hex>  <name>" (binary mode marks the name with "*"). */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2].replace(/^.*\//, ""), match[1].toLowerCase());
  }
  return sums;
}

export function findSumsAsset(assets: readonly GitHubAsset[]): GitHubAsset | undefined {
  return assets.find((a) => /^(sha256sums|checksums)(\.txt)?$/i.test(a.name));
}

/**
 * Whether the release was built without an Apple Developer ID signature. The release workflow (Instance 1)
 * marks it in the notes; an "unsigned" file name also counts. If neither says so we treat it as signed, and the
 * panel still links to the steps in case macOS refuses to open it.
 */
export function isUnsigned(release: Pick<GitHubRelease, "body" | "assets">): boolean {
  const body = release.body ?? "";
  if (/<!--\s*agency:signed\s*-->/i.test(body)) return false;
  if (/<!--\s*agency:unsigned\s*-->/i.test(body)) return true;
  if (/\b(unsigned|not (code[- ])?signed|not notari[sz]ed)\b/i.test(body)) return true;
  return release.assets.some((a) => /unsigned/i.test(a.name));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "10 October 2026": spelled-out month, so the date can't be misread as day/month or month/day. */
export function formatDate(iso: string | null): string {
  if (!iso) return "date not given";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "date not given";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function kindLabel(kind: DmgKind): string {
  return kind === "arm64" ? "Apple silicon (M1 or later)" : kind === "x64" ? "Intel" : "any Mac (universal)";
}

// --- What the GitHub API told us -------------------------------------------------------------------------

export type ReleaseState =
  | { kind: "ok"; release: GitHubRelease }
  | { kind: "no-release" }
  | { kind: "private-or-missing" }
  | { kind: "rate-limited"; resetAt: Date | null }
  | { kind: "error"; detail: string };

export interface ApiResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<ApiResponse>;

const API = "https://api.github.com";
const JSON_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

function rateLimited(res: ApiResponse): ReleaseState | null {
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    return {
      kind: "rate-limited",
      resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null,
    };
  }
  if (res.status === 429) return { kind: "rate-limited", resetAt: null };
  return null;
}

function looksLikeRelease(value: unknown): value is GitHubRelease {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["tag_name"] === "string" && typeof v["html_url"] === "string" && Array.isArray(v["assets"]);
}

/**
 * Ask GitHub for the latest release. Without a login, GitHub answers 404 both for a private repository and for
 * one that doesn't exist, so when there's no release we ask about the repository itself to tell "no release yet"
 * (public repository) from "private or missing" (release files can't be downloaded without a GitHub login).
 */
export async function loadLatestRelease(repo: string, fetcher: Fetcher): Promise<ReleaseState> {
  try {
    const res = await fetcher(`${API}/repos/${repo}/releases/latest`, { headers: JSON_HEADERS });
    const limited = rateLimited(res);
    if (limited) return limited;
    if (res.status === 200) {
      const body = await res.json();
      return looksLikeRelease(body)
        ? { kind: "ok", release: body }
        : { kind: "error", detail: "GitHub sent an answer we couldn't read." };
    }
    if (res.status !== 404) return { kind: "error", detail: `GitHub answered with status ${res.status}.` };

    const repoRes = await fetcher(`${API}/repos/${repo}`, { headers: JSON_HEADERS });
    const repoLimited = rateLimited(repoRes);
    if (repoLimited) return repoLimited;
    if (repoRes.status === 200) return { kind: "no-release" };
    if (repoRes.status === 404) return { kind: "private-or-missing" };
    return { kind: "error", detail: `GitHub answered with status ${repoRes.status}.` };
  } catch {
    return { kind: "error", detail: "We couldn't reach GitHub." };
  }
}

/** The SHA-256 of a file in the release: GitHub's own digest first, then the release's SHA256SUMS file. */
export async function findSha256(
  release: GitHubRelease,
  asset: GitHubAsset,
  fetchText: (url: string) => Promise<string | null>,
): Promise<{ sha256: string; source: "github" | "sums-file" } | null> {
  const fromGitHub = sha256FromDigest(asset.digest);
  if (fromGitHub) return { sha256: fromGitHub, source: "github" };
  const sumsAsset = findSumsAsset(release.assets);
  if (!sumsAsset) return null;
  const text = await fetchText(sumsAsset.url).catch(() => null);
  const fromFile = text ? parseSha256Sums(text).get(asset.name) : undefined;
  return fromFile ? { sha256: fromFile, source: "sums-file" } : null;
}
