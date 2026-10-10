/**
 * Development only: read the repository's .env so `make os-dev` uses the same keys as `make demo` (the
 * coordinator reads it itself). Only AI keys and AGENCY_* settings are taken, and the environment wins. The
 * packaged app never reads files from the repository; it uses the macOS keychain.
 */

const ALLOWED = /^(GEMINI_API_KEY|GOOGLE_API_KEY|ANTHROPIC_API_KEY|AGENCY_[A-Z0-9_]+)$/;

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (ALLOWED.test(key) && value) out[key] = value;
  }
  return out;
}

/** Copies allowed keys from `text` into `env` where `env` doesn't already have them. Returns the keys set. */
export function applyDotenv(text: string, env: NodeJS.ProcessEnv): string[] {
  const set: string[] = [];
  for (const [k, v] of Object.entries(parseDotenv(text))) {
    if (env[k]) continue;
    env[k] = v;
    set.push(k);
  }
  return set;
}
