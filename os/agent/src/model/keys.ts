/**
 * API keys come from the environment or the macOS keychain, read in the agent utility process. They are never
 * passed to, stored by, or readable from renderer code.
 *
 *   Gemini (default)   env GEMINI_API_KEY      keychain service "AGENCY", account "gemini-api-key"
 *   Claude (optional)  env ANTHROPIC_API_KEY   keychain service "AGENCY", account "anthropic-api-key"
 *
 * A caregiver can add a key with:  security add-generic-password -s AGENCY -a gemini-api-key -w
 */

import { execFile } from "node:child_process";

export type Provider = "gemini" | "anthropic";
export type KeySource = "env" | "keychain" | "none";

export const KEYCHAIN_SERVICE = "AGENCY";
export const KEYS: Record<Provider, { env: string; account: string }> = {
  gemini: { env: "GEMINI_API_KEY", account: "gemini-api-key" },
  anthropic: { env: "ANTHROPIC_API_KEY", account: "anthropic-api-key" },
};

export async function findApiKey(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readKeychain: (account: string) => Promise<string | null> = keychainLookup,
): Promise<{ key: string | null; source: KeySource }> {
  const fromEnv = env[KEYS[provider].env]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (platform === "darwin") {
    const fromKeychain = (await readKeychain(KEYS[provider].account))?.trim();
    if (fromKeychain) return { key: fromKeychain, source: "keychain" };
  }
  return { key: null, source: "none" };
}

function keychainLookup(account: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { timeout: 5000 },
      (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      },
    );
  });
}
