import { describe, expect, it } from "vitest";
import {
  chooseDmg,
  classifyDmg,
  findDmgs,
  findSha256,
  formatBytes,
  formatDate,
  isUnsigned,
  loadLatestRelease,
  parseSha256Sums,
  sha256FromDigest,
  type ApiResponse,
  type Fetcher,
  type GitHubAsset,
  type GitHubRelease,
} from "../../src/lib/release";

const HEX = "a".repeat(64);
const HEX2 = "b".repeat(64);

function asset(name: string, extra: Partial<GitHubAsset> = {}): GitHubAsset {
  return {
    name,
    size: 123_456_789,
    browser_download_url: `https://github.com/o/r/releases/download/v1.0.0/${name}`,
    url: `https://api.github.com/repos/o/r/releases/assets/${name}`,
    ...extra,
  };
}

function release(assets: GitHubAsset[], body = ""): GitHubRelease {
  return {
    tag_name: "v1.0.0",
    name: "AGENCY OS 1.0.0",
    published_at: "2026-10-09T18:30:00Z",
    html_url: "https://github.com/o/r/releases/tag/v1.0.0",
    body,
    assets,
  };
}

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): ApiResponse {
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe("classifyDmg", () => {
  it.each([
    ["AGENCY-1.0.0-arm64.dmg", "arm64"],
    ["AGENCY-1.0.0-aarch64.dmg", "arm64"],
    ["AGENCY-apple-silicon.dmg", "arm64"],
    ["AGENCY-1.0.0-x64.dmg", "x64"],
    ["AGENCY-1.0.0-x86_64.dmg", "x64"],
    ["AGENCY-Intel.dmg", "x64"],
    ["AGENCY-1.0.0-universal.dmg", "universal"],
    ["AGENCY-1.0.0.dmg", "unmarked"],
    ["AGENCY-1.0.0-arm64.zip", null],
    ["SHA256SUMS", null],
    ["AGENCY-1.0.0-arm64.dmg.blockmap", null],
  ])("%s → %s", (name, kind) => {
    expect(classifyDmg(name)).toBe(kind);
  });
});

describe("findDmgs and chooseDmg", () => {
  const arm = asset("AGENCY-1.0.0-arm64.dmg");
  const intel = asset("AGENCY-1.0.0-x64.dmg");
  const uni = asset("AGENCY-1.0.0-universal.dmg");

  it("treats electron-builder's unmarked .dmg as Intel when an arm64 one exists", () => {
    const plain = asset("AGENCY-1.0.0.dmg");
    expect(findDmgs([arm, plain])).toEqual({ arm64: arm, x64: plain });
  });

  it("offers a lone unmarked .dmg as the only choice without claiming a chip", () => {
    const plain = asset("AGENCY.dmg");
    const choice = chooseDmg(findDmgs([plain]), "x64");
    expect(choice.primary?.asset).toBe(plain);
    expect(choice.primary?.kind).toBe("universal");
  });

  it("picks the matching chip and offers the other", () => {
    const dmgs = findDmgs([intel, arm, asset("SHA256SUMS")]);
    expect(chooseDmg(dmgs, "arm64").primary?.asset).toBe(arm);
    expect(chooseDmg(dmgs, "arm64").others.map((o) => o.asset)).toEqual([intel]);
    expect(chooseDmg(dmgs, "x64").primary?.asset).toBe(intel);
    expect(chooseDmg(dmgs, "x64").guessed).toBe(false);
  });

  it("recommends Apple silicon when the chip is unknown, and says it guessed", () => {
    const choice = chooseDmg(findDmgs([intel, arm]), "unknown");
    expect(choice.primary?.asset).toBe(arm);
    expect(choice.guessed).toBe(true);
  });

  it("prefers a universal build when the chip is unknown or has no build of its own", () => {
    expect(chooseDmg(findDmgs([uni, arm]), "unknown")).toMatchObject({
      primary: { asset: uni },
      guessed: false,
    });
    expect(chooseDmg(findDmgs([uni, arm]), "x64").primary?.asset).toBe(uni);
    expect(chooseDmg(findDmgs([uni, arm]), "arm64").primary?.asset).toBe(arm);
  });

  it("falls back to the only build there is", () => {
    expect(chooseDmg(findDmgs([intel]), "arm64").primary?.asset).toBe(intel);
  });

  it("has no primary when the release has no .dmg", () => {
    expect(chooseDmg(findDmgs([asset("notes.txt")]), "arm64")).toEqual({ others: [], guessed: false });
  });
});

describe("checksums", () => {
  it("reads GitHub's digest field", () => {
    expect(sha256FromDigest(`sha256:${HEX.toUpperCase()}`)).toBe(HEX);
    expect(sha256FromDigest("sha512:abc")).toBeNull();
    expect(sha256FromDigest(null)).toBeNull();
    expect(sha256FromDigest(undefined)).toBeNull();
  });

  it("parses shasum and sha256sum output, including binary mode and paths", () => {
    const sums = parseSha256Sums(
      `${HEX}  AGENCY-1.0.0-arm64.dmg\n${HEX2} *dist/AGENCY-1.0.0-x64.dmg\r\n\nnot a line\n`,
    );
    expect(sums.get("AGENCY-1.0.0-arm64.dmg")).toBe(HEX);
    expect(sums.get("AGENCY-1.0.0-x64.dmg")).toBe(HEX2);
    expect(sums.size).toBe(2);
  });

  it("prefers GitHub's digest, then the SHA256SUMS file, then gives up honestly", async () => {
    const dmg = asset("AGENCY-1.0.0-arm64.dmg", { digest: `sha256:${HEX}` });
    const sums = asset("SHA256SUMS");
    const text = async () => `${HEX2}  AGENCY-1.0.0-arm64.dmg\n`;
    expect(await findSha256(release([dmg, sums]), dmg, text)).toEqual({ sha256: HEX, source: "github" });

    const bare = asset("AGENCY-1.0.0-arm64.dmg");
    expect(await findSha256(release([bare, sums]), bare, text)).toEqual({
      sha256: HEX2,
      source: "sums-file",
    });
    expect(await findSha256(release([bare, sums]), bare, async () => null)).toBeNull();
    expect(
      await findSha256(release([bare, sums]), bare, async () => {
        throw new TypeError("CORS");
      }),
    ).toBeNull();
    expect(await findSha256(release([bare]), bare, text)).toBeNull();
  });
});

describe("isUnsigned", () => {
  it("follows the release workflow's explicit marker first", () => {
    expect(isUnsigned(release([], "<!-- agency:unsigned -->"))).toBe(true);
    expect(isUnsigned(release([], "<!-- agency:signed --> mentions unsigned builds of old"))).toBe(false);
  });
  it("recognises plain wording and file names", () => {
    expect(isUnsigned(release([], "This build is not notarized."))).toBe(true);
    expect(isUnsigned(release([], "Unsigned build"))).toBe(true);
    expect(isUnsigned(release([asset("AGENCY-unsigned-arm64.dmg")]))).toBe(true);
    expect(isUnsigned(release([asset("AGENCY-arm64.dmg")], "Signed and notarized."))).toBe(false);
    expect(isUnsigned({ body: null, assets: [] })).toBe(false);
  });
});

describe("formatting", () => {
  it("formats sizes in decimal units, like Finder", () => {
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1_500)).toBe("1.5 KB");
    expect(formatBytes(123_456_789)).toBe("123 MB");
    expect(formatBytes(1_234_567_890)).toBe("1.2 GB");
    expect(formatBytes(-1)).toBe("unknown size");
  });
  it("spells out the month and uses UTC", () => {
    expect(formatDate("2026-10-09T23:30:00Z")).toBe("9 October 2026");
    expect(formatDate(null)).toBe("date not given");
    expect(formatDate("nonsense")).toBe("date not given");
  });
});

describe("loadLatestRelease", () => {
  const calls: string[] = [];
  const fake =
    (...answers: ApiResponse[]): Fetcher =>
    async (url) => {
      calls.push(url);
      const next = answers.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };

  it("returns the release", async () => {
    const r = release([asset("AGENCY-1.0.0-arm64.dmg")]);
    expect(await loadLatestRelease("o/r", fake(response(200, r)))).toEqual({ kind: "ok", release: r });
  });

  it("tells 'no release yet' (public repository) from 'private or missing'", async () => {
    expect(await loadLatestRelease("o/r", fake(response(404), response(200, { private: false })))).toEqual({
      kind: "no-release",
    });
    calls.length = 0;
    expect(await loadLatestRelease("o/r", fake(response(404), response(404)))).toEqual({
      kind: "private-or-missing",
    });
    expect(calls).toEqual([
      "https://api.github.com/repos/o/r/releases/latest",
      "https://api.github.com/repos/o/r",
    ]);
  });

  it("recognises GitHub's rate limit and when it resets", async () => {
    const state = await loadLatestRelease(
      "o/r",
      fake(response(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791676800" })),
    );
    expect(state).toEqual({ kind: "rate-limited", resetAt: new Date(1791676800 * 1000) });
    expect(await loadLatestRelease("o/r", fake(response(429)))).toEqual({
      kind: "rate-limited",
      resetAt: null,
    });
  });

  it("reports a 403 that isn't a rate limit, odd answers and network failures as errors", async () => {
    expect((await loadLatestRelease("o/r", fake(response(403)))).kind).toBe("error");
    expect((await loadLatestRelease("o/r", fake(response(200, { message: "?" })))).kind).toBe("error");
    expect((await loadLatestRelease("o/r", fake(response(500)))).kind).toBe("error");
    const offline: Fetcher = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await loadLatestRelease("o/r", offline)).toEqual({
      kind: "error",
      detail: "We couldn't reach GitHub.",
    });
  });
});
