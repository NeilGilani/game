import { describe, expect, it } from "vitest";
import { detectPlatform } from "../../src/lib/platform";

const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

describe("detectPlatform", () => {
  it("uses Chrome's client hints for the chip", () => {
    expect(
      detectPlatform({ userAgent: CHROME_MAC, clientHints: { platform: "macOS", architecture: "arm" } }),
    ).toEqual({
      os: "mac",
      arch: "arm64",
      archSource: "client-hints",
    });
    expect(
      detectPlatform({ userAgent: CHROME_MAC, clientHints: { platform: "macOS", architecture: "x86" } }).arch,
    ).toBe("x64");
  });

  it("uses a named Apple M-series GPU, or Intel/AMD graphics", () => {
    const m2 = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)";
    expect(detectPlatform({ userAgent: SAFARI_MAC, webglRenderer: m2 })).toMatchObject({
      arch: "arm64",
      archSource: "graphics",
    });
    expect(
      detectPlatform({ userAgent: SAFARI_MAC, webglRenderer: "Intel(R) Iris(TM) Plus Graphics 655" }).arch,
    ).toBe("x64");
    expect(
      detectPlatform({ userAgent: SAFARI_MAC, webglRenderer: "AMD Radeon Pro 5500M OpenGL Engine" }).arch,
    ).toBe("x64");
  });

  it("doesn't guess from Safari's generic 'Apple GPU' or the user agent's 'Intel Mac OS X'", () => {
    expect(detectPlatform({ userAgent: SAFARI_MAC, webglRenderer: "Apple GPU" })).toEqual({
      os: "mac",
      arch: "unknown",
      archSource: "none",
    });
    expect(detectPlatform({ userAgent: SAFARI_MAC }).arch).toBe("unknown");
  });

  it("recognises an iPad asking for the desktop site", () => {
    expect(detectPlatform({ userAgent: SAFARI_MAC, maxTouchPoints: 5 }).os).toBe("ios");
  });

  it("recognises other systems and never offers them a chip", () => {
    expect(
      detectPlatform({ userAgent: WINDOWS, clientHints: { platform: "Windows", architecture: "x86" } }),
    ).toEqual({
      os: "windows",
      arch: "unknown",
      archSource: "none",
    });
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }).os).toBe("linux");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)" }).os).toBe("android");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16000.0.0)" }).os).toBe("chromeos");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)" }).os).toBe(
      "ios",
    );
    expect(detectPlatform({ userAgent: "curl/8.0" }).os).toBe("other");
  });
});
