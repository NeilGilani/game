/**
 * Verification reads the page or screen back with AGENCY's own tools and checks the expected state. The
 * model's word is never enough: a step is done only when its expected text is really visible.
 */

import type { GuardedTools } from "../tools/guarded";

export interface Verification {
  ok: boolean;
  evidence: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * @param mustBeNew when set (page text before the last approved consequential action), the expected text must
 *   not have been on the page already, so stale or injected "Order confirmed" text can't fake success.
 */
export async function verifyVisible(tools: GuardedTools, expect: string, mustBeNew: string | null = null): Promise<Verification> {
  const want = norm(expect);
  if (want.length < 3) return { ok: false, evidence: "The expected text is too short to check." };
  let seen = "";
  let where = "";
  if (tools.bridge) {
    const snap = await tools.bridge.snapshot();
    seen = `${snap.title}\n${snap.text}\n${snap.nodes.map((n) => n.name).join("\n")}`;
    where = snap.url;
  } else if (tools.native) {
    const app = await tools.readApp(500);
    seen = app.targets.map((t) => t.label).join("\n");
    where = app.owner ?? "the frontmost app";
  } else {
    return { ok: false, evidence: "Nothing is connected that I can read back." };
  }
  if (!norm(seen).includes(want)) return { ok: false, evidence: `"${expect}" is not visible on ${where}.` };
  if (mustBeNew !== null && norm(mustBeNew).includes(want)) {
    return { ok: false, evidence: `"${expect}" was already on the page before the last action, so it doesn't prove anything changed.` };
  }
  return { ok: true, evidence: `Saw "${expect}" on ${where}.` };
}
