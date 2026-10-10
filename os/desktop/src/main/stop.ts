/** Global Stop: halts the agent and all synthetic input at the same moment. Neither waits for the other. */

import type { StopAllResult } from "@agency/contracts";
import type { Logger } from "./log";

export interface StopTargets {
  /** Sends stop.all to the agent. Returns false when no agent is running. Must not throw. */
  agent(): boolean;
  /** Calls input.stopAll on agency-native. Rejects or resolves false on failure. */
  native(): Promise<boolean> | null;
  /** Anything else to tell (overlay, shell). */
  notify?: (result: StopAllResult) => void;
}

export async function stopAll(
  targets: StopTargets,
  log: Logger,
  nativeTimeoutMs = 1_000,
): Promise<StopAllResult> {
  const at = Date.now();
  // Fire both before awaiting either.
  let agentSent = false;
  try {
    agentSent = targets.agent();
  } catch (err) {
    log.error(`stop.all to agent failed: ${(err as Error).message}`);
  }
  let nativeCall: Promise<boolean> | null = null;
  try {
    nativeCall = targets.native();
  } catch (err) {
    log.error(`input.stopAll failed: ${(err as Error).message}`);
    nativeCall = Promise.resolve(false);
  }
  let native: StopAllResult["native"] = "unavailable";
  if (nativeCall) {
    const ok = await Promise.race([
      nativeCall.catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), nativeTimeoutMs)),
    ]);
    native = ok ? "ok" : "failed";
  }
  const result: StopAllResult = { at, agent: agentSent ? "sent" : "unavailable", native };
  log.info(`stop all: agent=${result.agent} native=${result.native} in ${Date.now() - at} ms`);
  try {
    targets.notify?.(result);
  } catch {
    // Notifying is best effort.
  }
  return result;
}
