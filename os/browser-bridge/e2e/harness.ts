/**
 * End-to-end harness: the real extension in Playwright's Chromium (persistent context, --load-extension),
 * the real native host (dist/host.cjs, launched by Chromium through native messaging), and the real
 * AGENCY-side BridgeServer, all wired through a temporary folder. The host manifest goes into the test
 * profile's own NativeMessagingHosts folder, so the person's real Chrome is never touched.
 */

import { chromium, type BrowserContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeServer } from "../src/app/server.ts";
import { ensurePairing, installNativeHost } from "../src/app/install.ts";
import { startSandbox, type Sandbox } from "../../sandbox-web/src/server.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const EXT_DIR = join(ROOT, "dist", "extension");

export interface Rig {
  context: BrowserContext;
  bridge: BridgeServer;
  sandbox: Sandbox;
  dir: string;
  token: string;
  close: () => Promise<void>;
}

export interface RigOptions {
  headless?: boolean;
  args?: string[];
  viewport?: { width: number; height: number } | null;
  deviceScaleFactor?: number;
  /** Don't start the BridgeServer (pairing tests start their own). */
  noBridge?: boolean;
}

export async function startRig(opts: RigOptions = {}): Promise<Rig> {
  // Short folder name: macOS limits Unix socket paths to 104 bytes.
  const dir = mkdtempSync(join(tmpdir(), "agb-"));
  const profile = join(dir, "profile");
  const config = ensurePairing({ dir: join(dir, "bridge") });
  installNativeHost({
    configPath: config.configPath,
    hostScript: join(ROOT, "dist", "host.cjs"),
    runtime: process.execPath,
    manifestDirs: [join(profile, "NativeMessagingHosts")],
  });
  const sandbox = await startSandbox({ port: 0 });
  const bridge = new BridgeServer({ socketPath: config.socketPath, token: config.token });
  if (!opts.noBridge) await bridge.start();
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: opts.headless ?? process.env.HEADED !== "1",
    viewport: opts.viewport === undefined ? { width: 1280, height: 860 } : opts.viewport,
    ...(opts.deviceScaleFactor ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, ...(opts.args ?? [])],
  });
  if (!opts.noBridge) await bridge.waitUntilReady(20_000);
  return {
    context,
    bridge,
    sandbox,
    dir,
    token: config.token,
    close: async () => {
      await context.close().catch(() => undefined);
      await bridge.stop().catch(() => undefined);
      await sandbox.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
