/**
 * The Anthropic API key comes from the environment or the macOS keychain, read in the agent utility process.
 * It is never passed to, stored by, or readable from renderer code.
 *
 * Keychain item: generic password, service "AGENCY", account "anthropic-api-key". A caregiver can add it with
 *   security add-generic-password -s AGENCY -a anthropic-api-key -w
 */

import { execFile } from "node:child_process";

export const KEYCHAIN_SERVICE = "AGENCY";
export const KEYCHAIN_ACCOUNT = "anthropic-api-key";

export type KeySource = "env" | "keychain" | "none";

export async function findApiKey(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readKeychain: () => Promise<string | null> = keychainLookup,
): Promise<{ key: string | null; source: KeySource }> {
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (platform === "darwin") {
    const fromKeychain = (await readKeychain())?.trim();
    if (fromKeychain) return { key: fromKeychain, source: "keychain" };
  }
  return { key: null, source: "none" };
}

function keychainLookup(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeout: 5000 },
      (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      },
    );
  });
}
