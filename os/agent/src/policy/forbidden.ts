/**
 * Decisions reserved for the owner (PLAN.md, safety constitution 4): this agent never requests emergency
 * services and never unlocks a real door. Lifeline handles emergencies; the demo smart home is simulated.
 */

import type { AgentAction } from "../types";

const EMERGENCY_NUMBERS =
  /(^|[^\d])(911|112|999|000|110|119|118|117|100|101|102|108|190|192|193|197|15|17|18)([^\d]|$)/;
const EMERGENCY_WORDS =
  /\b(emergency services?|call (an )?ambulance|ambulance|fire (department|brigade)|police|dispatch|9-1-1|psap|emergency (call|sos)|sos)\b/i;
const DOOR_WORDS =
  /\b(unlock|open)\b[^.\n]{0,20}\b(door|lock|gate|garage)\b|\b(disarm|deactivate)\b[^.\n]{0,20}\b(alarm|security)\b/i;

export interface Forbidden {
  reason: string;
}

export function forbiddenAction(action: AgentAction): Forbidden | null {
  const text = [
    action.target?.label,
    action.target?.url,
    action.claim?.summary,
    ...Object.values(action.claim?.details ?? {}),
    JSON.stringify(action.input ?? {}),
  ]
    .filter(Boolean)
    .join(" ");
  const isCall = action.claim?.kind === "call" || /\b(call|dial|ring|facetime|tel:)/i.test(text);
  const hasEmergencyNumber =
    EMERGENCY_NUMBERS.test(String(action.input?.number ?? "")) || /tel:\s*\+?(911|112|999)\b/i.test(text);
  if (EMERGENCY_WORDS.test(text) && (isCall || /request|send|alert|contact/i.test(text))) {
    return {
      reason:
        "I don't contact emergency services myself. Look at Help to start Lifeline; it reaches your people right away.",
    };
  }
  if (isCall && (hasEmergencyNumber || /\b(911|112|999)\b/.test(text))) {
    return { reason: "I don't call emergency numbers myself. Look at Help to start Lifeline." };
  }
  if (DOOR_WORDS.test(text) && !action.target?.simulated) {
    return {
      reason: "I don't unlock real doors or turn off real alarms. Only the simulated demo home can do that.",
    };
  }
  return null;
}
