/**
 * Where AGENCY's AI comes from. Nobody is asked for an API key: with no key of their own, the coordinator and the
 * agent use AGENCY Cloud (Gemini on AGENCY's key through AGENCY's relay; docs/AI_RELAY.md). A key of your own still
 * wins (advanced: GEMINI_API_KEY in the environment, or the keychain item service "AGENCY", account
 * "gemini-api-key"). AGENCY_RELAY=off switches AGENCY Cloud off.
 */

/** Automated tests never spend AGENCY Cloud's budget unless they ask for it. */
export function applyAiDefaults(env: NodeJS.ProcessEnv, test: boolean): void {
  if (test && !env.AGENCY_RELAY) env.AGENCY_RELAY = "off";
}

/** The status line for the agent's AI, from the status the agent sends once at start. */
export function aiStatusLabel(status: Record<string, unknown> | null | undefined): string {
  if (!status) return "AI: starting";
  if (typeof status.ai === "string" && status.ai) return status.ai;
  if (status.fake === true) return "AI: fake agent";
  return status.model === true ? "AI: on" : "AI: off";
}
