/**
 * "Order for real" (Settings, For a helper): whether the agent's ordering pack may order on the person's own
 * DoorDash, Uber Eats, Amazon or Instacart in Chrome, and the most one order may cost. Main writes it into the
 * agent's settings file (<userData>/agent-settings.json, AGENCY_AGENT_SETTINGS), which the agent re-reads on every
 * check and never writes. Only the shell may change it; the agent and web pages can't.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RealOrderingSetting } from "@agency/contracts";

export const ORDERING_DEFAULT: RealOrderingSetting = { enabled: false, maxOrder: 60 };
/** The cap a caregiver can set, in dollars. */
export const ORDERING_CAP_RANGE = { min: 5, max: 500 } as const;

/** A setting from the shell, checked; null when anything is off (wrong types, cap out of range). */
export function parseOrdering(value: unknown): RealOrderingSetting | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") return null;
  const cap = v.maxOrder;
  if (typeof cap !== "number" || !Number.isFinite(cap)) return null;
  if (cap < ORDERING_CAP_RANGE.min || cap > ORDERING_CAP_RANGE.max) return null;
  return { enabled: v.enabled, maxOrder: Math.round(cap * 100) / 100 };
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What the agent will read now. Anything unreadable counts as off. */
export function readOrdering(file: string): RealOrderingSetting {
  return parseOrdering(readJson(file).realOrdering) ?? ORDERING_DEFAULT;
}

/** Writes only the realOrdering key, keeping any other limits a caregiver set in the file. */
export function writeOrdering(file: string, setting: RealOrderingSetting): void {
  const next = { ...readJson(file), realOrdering: setting };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
