/**
 * Risk classification of every action. The result is the maximum of what the code infers from the live
 * target, any sandbox or pack hint, and what the model claims. Nothing can lower it.
 */

import type { ConsequentialKind, RiskLevel } from "@agency/contracts";
import type { AgentAction } from "../types";

export interface Classification {
  risk: RiskLevel;
  kind?: ConsequentialKind;
  reason: string;
}

const RANK: Record<RiskLevel, number> = { read: 0, reversible: 1, consequential: 2 };

/** Ordered: the first match wins, so the more specific phrases come first. */
const LABEL_RULES: { kind: ConsequentialKind; re: RegExp }[] = [
  {
    kind: "account-or-settings",
    re: /\b(sign[ -]?up|register|create (an )?account|change (your )?(password|email|address|phone)|update (your )?(password|email|address|phone|account)|delete (my |your )?account|close (my |your )?account|log ?out|sign ?out|save (settings|changes|preferences)|privacy settings|security settings)\b/i,
  },
  {
    kind: "purchase",
    re: /\b(pay|buy|purchase|place (my |your |the )?order|order now|check ?out|confirm (and pay|order|purchase|payment)|complete (order|purchase|payment)|subscribe|donate|add funds|transfer|tip)\b/i,
  },
  {
    kind: "sign",
    re: /\b(e-?sign|sign (the |this )?(document|form|here|now|and submit)|adopt (and sign|signature)|apply signature|^sign$)\b/i,
  },
  { kind: "call", re: /\b(call|dial|ring|place (a |the )?call|start (a )?call|video call|facetime)\b/i },
  { kind: "send", re: /\b(send|post|publish|tweet|share|reply all and send|message (them|now))\b/i },
  {
    kind: "delete",
    re: /\b(delete|remove (my |this |the |a )?(account|contact|file|photo|message|email|member|friend|card|address|payment method|document)|trash|discard|erase|empty bin|unsubscribe|cancel (my |the |this )?(order|subscription|appointment|booking|membership))\b/i,
  },
  {
    kind: "install",
    re: /\b(install|add to chrome|add extension|download and (open|install)|allow (access|notifications|permission))\b/i,
  },
  {
    kind: "submit",
    re: /\b(submit|apply|file (claim|form|return)|confirm|finish|complete|book|reserve|schedule|rsvp|request (appointment|refill)|accept)\b/i,
  },
];

/** Typing these into a third-party page shares personal data. */
const PERSONAL_DATA = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
  /\b(ssn|social security|date of birth|dob|passport|driver'?s licen[cs]e|medicare|insurance (id|number)|diagnosis)\b/i,
];
const PERSONAL_FIELD = /^(bday|bday-day|bday-month|bday-year|sex|transaction-amount)$/i;
const PERSONAL_FIELD_LABEL =
  /\b(ssn|social security|date of birth|birthday|passport|licen[cs]e number|medicare|medicaid|insurance (id|member|number)|diagnosis|medical record)\b/i;

const READ_OPS = new Set([
  "bridge.read",
  "native.read",
  "computer.screenshot",
  "computer.zoom",
  "computer.cursor_position",
  "computer.wait",
  "computer.mouse_move",
  "computer.scroll",
  "native.scroll",
]);

export function classify(action: AgentAction): Classification {
  const inferred = infer(action);
  let best: Classification = inferred;
  const hint = action.target?.riskHint;
  if (hint && RANK[best.risk] < RANK.consequential)
    best = { risk: "consequential", kind: hint, reason: `the page marks this as ${hint}` };
  const claim = action.claim;
  if (claim?.risk && RANK[claim.risk] > RANK[best.risk]) {
    best = {
      risk: claim.risk,
      kind: claim.kind ?? best.kind,
      reason: "the agent marked this as " + claim.risk,
    };
  } else if (claim?.kind && best.risk === "consequential" && !best.kind) {
    best = { ...best, kind: claim.kind };
  } else if (claim?.kind && RANK[best.risk] < RANK.consequential) {
    best = { risk: "consequential", kind: claim.kind, reason: `the agent marked this as ${claim.kind}` };
  }
  if (best.risk === "consequential" && !best.kind) best = { ...best, kind: "submit" };
  return best;
}

function infer(action: AgentAction): Classification {
  const op = action.op;
  if (READ_OPS.has(op)) return { risk: "read", reason: "only looks" };
  const label = (action.target?.label ?? "").trim();

  if (op === "bridge.select") {
    // Choosing in a list is like clicking that option: "Subscribe & Save" is a purchase, "Medium" is not.
    const option = String(action.input?.option ?? "").trim();
    for (const rule of LABEL_RULES) {
      if (rule.re.test(option))
        return {
          risk: "consequential",
          kind: rule.kind,
          reason: `"${option}" can ${rule.kind.replace(/-/g, " ")}`,
        };
    }
    return { risk: "reversible", reason: "chooses an option in a list" };
  }
  if (op === "bridge.navigate" || op === "native.launch" || op === "native.activate") {
    return { risk: "reversible", reason: "opens a page or app" };
  }
  if (op.endsWith(".type")) {
    const text = String(action.input?.text ?? "");
    if (
      PERSONAL_DATA.some((re) => re.test(text)) ||
      PERSONAL_FIELD_LABEL.test(label) ||
      PERSONAL_FIELD.test(String(action.input?.autocomplete ?? ""))
    ) {
      return {
        risk: "consequential",
        kind: "share-personal-data",
        reason: "types personal information into a page",
      };
    }
    return { risk: "reversible", reason: "types into a field (nothing is sent yet)" };
  }
  if (op === "computer.key" || op === "native.key") {
    const key = String(action.input?.key ?? action.input?.text ?? "").toLowerCase();
    if (/(^|\+)(return|enter|kp_enter)$/.test(key))
      return { risk: "consequential", kind: "submit", reason: "Enter can submit or send" };
    if (
      /(cmd|super|ctrl)\+(backspace|delete)$/.test(key) ||
      (/(^|\+)(delete|backspace)$/.test(key) && /shift|cmd/.test(key))
    ) {
      return { risk: "consequential", kind: "delete", reason: "the key deletes" };
    }
    return { risk: "reversible", reason: "presses a key" };
  }
  if (
    /click|press/.test(op) ||
    op === "computer.left_click_drag" ||
    op === "computer.left_mouse_down" ||
    op === "computer.left_mouse_up"
  ) {
    if (!label) {
      return {
        risk: "consequential",
        kind: "submit",
        reason: "I can't tell what this control does, so I need to ask",
      };
    }
    for (const rule of LABEL_RULES) {
      if (rule.re.test(label))
        return {
          risk: "consequential",
          kind: rule.kind,
          reason: `"${label}" can ${rule.kind.replace(/-/g, " ")}`,
        };
    }
    if (action.target?.role === "button" && action.input?.submits === true) {
      return { risk: "consequential", kind: "submit", reason: "the button submits a form" };
    }
    return { risk: "reversible", reason: `"${label}" opens or selects something` };
  }
  if (op.startsWith("pack.")) return { risk: "reversible", reason: "task pack step" };
  // Anything unknown is treated as consequential: safer to ask than to guess.
  return { risk: "consequential", kind: "submit", reason: "unknown action" };
}

export function riskAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RANK[a] >= RANK[b];
}
