/**
 * Pairing and installation on the person's Mac, called by AGENCY.app (Instance 1) at first run:
 *  1. ensurePairing(): a random 32-byte token in ~/Library/Application Support/AGENCY/bridge/bridge.json
 *     (mode 0600, folder 0700), shared by the app and the host; the extension receives it once.
 *  2. installNativeHost(): a small launcher script plus the native messaging host manifest in each
 *     installed Chromium browser's NativeMessagingHosts folder, allowing only the AGENCY Bridge extension.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_HOST_NAME } from "../protocol.ts";
import { EXTENSION_ID } from "../extension/extension-id.ts";
import type { HostConfig } from "../host/host.ts";

export { EXTENSION_ID };

/** macOS limits Unix socket paths to 104 bytes. */
const MAX_SOCKET_PATH = 103;

export function defaultBridgeDir(home = homedir()): string {
  return join(home, "Library", "Application Support", "AGENCY", "bridge");
}

export interface PairingOptions {
  dir?: string;
  /** Extension IDs allowed to use the host. Defaults to the unpacked build's fixed ID. */
  extensionIds?: string[];
}

export function ensurePairing(opts: PairingOptions = {}): HostConfig & { configPath: string } {
  const dir = opts.dir ?? defaultBridgeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const configPath = join(dir, "bridge.json");
  let socketPath = join(dir, "bridge.sock");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) socketPath = join("/tmp", `agency-bridge-${process.getuid?.() ?? "user"}.sock`);
  let token: string | undefined;
  if (existsSync(configPath)) {
    try {
      const old = JSON.parse(readFileSync(configPath, "utf8")) as Partial<HostConfig>;
      if (typeof old.token === "string" && /^[0-9a-f]{64}$/.test(old.token)) token = old.token;
    } catch {
      /* rewritten below */
    }
  }
  token ??= randomBytes(32).toString("hex");
  const config: HostConfig = { socketPath, token, extensionIds: opts.extensionIds ?? [EXTENSION_ID] };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { ...config, configPath };
}

/** A new token: the extension will show "AGENCY has changed" until the person pairs again. */
export function resetPairing(opts: PairingOptions = {}): HostConfig & { configPath: string } {
  const dir = opts.dir ?? defaultBridgeDir();
  rmSync(join(dir, "bridge.json"), { force: true });
  return ensurePairing(opts);
}

/** User-level NativeMessagingHosts folders, relative to ~/Library/Application Support. */
export const BROWSER_DIRS: Record<string, string> = {
  chrome: "Google/Chrome",
  "chrome-beta": "Google/Chrome Beta",
  "chrome-dev": "Google/Chrome Dev",
  "chrome-canary": "Google/Chrome Canary",
  chromium: "Chromium",
  brave: "BraveSoftware/Brave-Browser",
  edge: "Microsoft Edge",
};

export interface InstallOptions {
  configPath: string;
  /** Absolute path of the bundled host script (dist/host.cjs, or inside AGENCY.app's resources). */
  hostScript: string;
  /** The Node binary, or the Electron binary with runAsNode. */
  runtime: string;
  runAsNode?: boolean;
  extensionIds?: string[];
  /** Where to write the launcher. Defaults to the config's folder. */
  launcherDir?: string;
  /**
   * NativeMessagingHosts folders to write to. Defaults to Chrome's, plus every other Chromium browser
   * whose profile folder exists.
   */
  manifestDirs?: string[];
  home?: string;
}

export function hostManifest(launcher: string, extensionIds: string[]): object {
  return {
    name: NATIVE_HOST_NAME,
    description: "AGENCY Bridge: connects the AGENCY Bridge extension to the AGENCY app on this Mac.",
    path: launcher,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function defaultManifestDirs(home = homedir()): string[] {
  const base = join(home, "Library", "Application Support");
  const out: string[] = [];
  for (const [name, rel] of Object.entries(BROWSER_DIRS)) {
    const profile = join(base, rel);
    if (name === "chrome" || existsSync(profile)) out.push(join(profile, "NativeMessagingHosts"));
  }
  return out;
}

export function installNativeHost(opts: InstallOptions): { launcher: string; manifests: string[] } {
  const ids = opts.extensionIds ?? [EXTENSION_ID];
  const launcherDir = opts.launcherDir ?? dirname(opts.configPath);
  mkdirSync(launcherDir, { recursive: true, mode: 0o700 });
  const launcher = join(launcherDir, "agency-bridge-host");
  const env = opts.runAsNode ? "ELECTRON_RUN_AS_NODE=1 " : "";
  writeFileSync(
    launcher,
    `#!/bin/sh\n# AGENCY Bridge native messaging host launcher (written by AGENCY).\n` +
      `${env}exec ${shellQuote(opts.runtime)} ${shellQuote(opts.hostScript)} --config ${shellQuote(opts.configPath)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(launcher, 0o700);
  const manifests: string[] = [];
  for (const dir of opts.manifestDirs ?? defaultManifestDirs(opts.home)) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(file, JSON.stringify(hostManifest(launcher, ids), null, 2) + "\n", { mode: 0o644 });
    manifests.push(file);
  }
  return { launcher, manifests };
}

export function uninstallNativeHost(manifestDirs: string[] = defaultManifestDirs()): string[] {
  const removed: string[] = [];
  for (const dir of manifestDirs) {
    const file = join(dir, `${NATIVE_HOST_NAME}.json`);
    if (existsSync(file)) {
      rmSync(file);
      removed.push(file);
    }
  }
  return removed;
}
