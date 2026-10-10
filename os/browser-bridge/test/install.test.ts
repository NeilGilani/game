import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTENSION_ID,
  defaultManifestDirs,
  ensurePairing,
  installNativeHost,
  resetPairing,
  uninstallNativeHost,
} from "../src/app/install.ts";
import manifest from "../extension/manifest.json" with { type: "json" };
import { createHash } from "node:crypto";

describe("installation", () => {
  it("derives the extension id from the manifest key", () => {
    const der = Buffer.from(manifest.key, "base64");
    const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join("");
    expect(id).toBe(EXTENSION_ID);
  });

  it("keeps the same token across runs, and resetting makes a new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbi-"));
    try {
      const a = ensurePairing({ dir });
      const b = ensurePairing({ dir });
      expect(b.token).toBe(a.token);
      expect(a.token).toMatch(/^[0-9a-f]{64}$/);
      expect(resetPairing({ dir }).token).not.toBe(a.token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a launcher and a host manifest that only allows the AGENCY Bridge", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbi-"));
    try {
      const cfg = ensurePairing({ dir });
      const nm = join(dir, "Chrome", "NativeMessagingHosts");
      const { launcher, manifests } = installNativeHost({
        configPath: cfg.configPath,
        hostScript: "/Apps/AGENCY.app/host.cjs",
        runtime: "/Apps/AGENCY.app/AGENCY",
        runAsNode: true,
        manifestDirs: [nm],
      });
      expect(manifests).toEqual([join(nm, "com.agency.bridge.json")]);
      const m = JSON.parse(readFileSync(manifests[0]!, "utf8"));
      expect(m).toEqual({
        name: "com.agency.bridge",
        description: expect.any(String),
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      });
      const sh = readFileSync(launcher, "utf8");
      expect(sh).toContain(
        "ELECTRON_RUN_AS_NODE=1 exec '/Apps/AGENCY.app/AGENCY' '/Apps/AGENCY.app/host.cjs' --config",
      );
      expect(statSync(launcher).mode & 0o777).toBe(0o700);
      expect(uninstallNativeHost([nm])).toEqual(manifests);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("targets Chrome's NativeMessagingHosts folder by default", () => {
    expect(defaultManifestDirs("/Users/riley")[0]).toBe(
      "/Users/riley/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    );
  });
});
