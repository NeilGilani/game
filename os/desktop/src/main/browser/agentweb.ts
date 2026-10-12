/**
 * The assistant's web limits, from AGENCY Browser's settings (Settings, For a helper): main writes them into the
 * agent's settings file (agent-settings.json), which the agent re-reads on every check and never writes. These are
 * the guard's own settings (os/agent/src/policy/settings.ts); nothing here loosens the guard's rules:
 *
 * - "Any website" adds "https://*" and "http://*" to the guard's site list, so the assistant may open, read and take
 *   reversible steps on any site. Everything consequential still needs the person's approval of that exact action.
 * - "Real actions" turns the guard's simulated-only mode off. Off (the default), consequential actions run only on
 *   the practice sites, whatever the person approves.
 *
 * Other keys a caregiver set in the file (spending limits, real ordering) are kept as they are.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserSettings } from "@agency/contracts";

/** The agent's own default site list (os/agent DEFAULT_SETTINGS), used when the file has none yet. */
export const AGENT_DEFAULT_SITES = ["http://localhost:*", "http://127.0.0.1:*", "*.sandbox.agency.test"];
export const ANY_SITE = ["https://*", "http://*"];

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The file's contents with the browser's two settings applied. Pure, for tests. */
export function withWebSettings(
  current: Record<string, unknown>,
  s: Pick<BrowserSettings, "agentAnySite" | "realActions">,
): Record<string, unknown> {
  const list = Array.isArray(current.siteAllowlist)
    ? current.siteAllowlist.filter((e): e is string => typeof e === "string")
    : AGENT_DEFAULT_SITES;
  const base = list.filter((e) => !ANY_SITE.includes(e));
  return {
    ...current,
    siteAllowlist: s.agentAnySite ? [...base, ...ANY_SITE] : base,
    simulatedOnly: !s.realActions,
  };
}

export function writeWebSettings(file: string, s: Pick<BrowserSettings, "agentAnySite" | "realActions">): void {
  const next = withWebSettings(readJson(file), s);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
