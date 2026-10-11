/**
 * Context priors for eye control: which dwell targets are likely on this screen, so a gaze estimate
 * that falls between two targets goes to the one the task makes likely (os/gaze/src/input/intent.ts).
 *
 * Where the context comes from, all on this device:
 * - The planner: the coordinator's case state (backend/agency/engine `next_actions`: waiting for an
 *   answer, waiting for an approval, paused) and the agent's task state (a question, a result, paused).
 *   Screens mark the controls that would move the task on with `data-likely="strong"`.
 * - Simple rules: in a form, the first empty field is likely, and once every required field is filled,
 *   the submit button; the person's usual and word predictions are weakly likely (`data-likely`).
 *
 * How much a prior may count was measured in os/gaze/bench/intent.bench.ts (simulated): a prior of 1.5
 * pays off if the context is right more than about 6 times in 10, 1.25 if more than about 4 in 10.
 * So "strong" (the planner is waiting for exactly this) is 1.5 and "weak" (a guess) is 1.25.
 *
 * Safety, enforced here and in intent.ts:
 * - Anything that pays, sends, shares, signs, calls, submits or deletes is consequential: never
 *   predicted, never a shorter dwell. It still goes through the approval flow.
 * - Approval gates (`data-approval-gate`: Approve, Confirm, Sign) never get more than a neutral prior.
 * - Stop, Help, Lifeline and "Resume eye control" are protected: context can never make them harder.
 * Nothing here reads the camera; it sees labels and attributes of on-screen controls.
 */

import type { NextAction } from "../api/types";
import type { TaskView } from "../state/tasks";

export const LIKELY = { strong: 1.5, weak: 1.25 } as const;
export type Likely = keyof typeof LIKELY;

/** Spread into a control's props: `<button {...likely(isNext && "strong")}>`. */
export function likely(level: Likely | false | null | undefined): { "data-likely"?: Likely } {
  return level ? { "data-likely": level } : {};
}

/** Words of actions that pay, send, share, sign, call, submit or delete. */
const CONSEQUENTIAL =
  /\b(pay|payment|buy|purchase|order|checkout|send|share|sign|call|dial|submit|delete|remove|transfer|post|publish|book|approve|confirm|unlock)\b/i;
const PROTECTED = /\b(stop|help|lifeline|emergency|sos)\b/i;

export interface TargetFacts {
  label: string;
  /** data-likely: "strong", "weak", or a number. */
  likely?: string | null;
  /** data-consequential present. */
  consequential?: boolean;
  /** data-approval-gate present. */
  gate?: boolean;
  /** data-protect or data-dwell-always present. */
  protect?: boolean;
  /** The form rule picked this control (first empty field, or submit once the form is complete). */
  formNext?: boolean;
}

export interface TargetContext {
  prior: number;
  consequential: boolean;
  gate: boolean;
  protect: boolean;
}

/** The prior and safety flags for one control. Pure. */
export function contextFor(f: TargetFacts): TargetContext {
  const label = f.label ?? "";
  const gate = !!f.gate;
  const consequential = gate || !!f.consequential || CONSEQUENTIAL.test(label);
  const protect = !!f.protect || PROTECTED.test(label);
  let prior = 1;
  if (f.likely === "strong" || f.formNext) prior = LIKELY.strong;
  else if (f.likely === "weak" || f.likely === "") prior = LIKELY.weak;
  else if (f.likely && Number.isFinite(Number(f.likely))) prior = Number(f.likely);
  if (gate) prior = Math.min(1, prior);
  return { prior, consequential, gate, protect };
}

// --- Planner state -> what is likely ------------------------------------------------------------

/** What would move an agent task on: answering its question, resuming it, or leaving its result. */
export function taskFocus(t: Pick<TaskView, "phase" | "question">): "answer" | "resume" | "finish" | null {
  if (t.phase === "question" && t.question) return "answer";
  if (t.phase === "paused") return "resume";
  if (t.phase === "done" || t.phase === "stopped") return "finish";
  // "approval" has none on purpose: the Approve button is a gate and never gets a boost.
  return null;
}

/** What would move a coordinator case on, from backend/agency/engine's next_actions. */
export function caseFocus(
  actions: readonly Pick<NextAction, "kind">[],
): "answer" | "review" | "resume" | null {
  const kinds = new Set(actions.map((a) => a.kind));
  if (kinds.has("paused")) return "resume";
  if (kinds.has("question")) return "answer";
  if (kinds.has("approval")) return "review";
  return null;
}

// --- Forms ----------------------------------------------------------------------------------------

export interface FormField {
  id: string;
  kind: "field" | "submit";
  empty: boolean;
  required: boolean;
}

/** The form rule: the first empty field is next; once every required field is filled, the submit. */
export function nextInForm(fields: readonly FormField[]): string | null {
  const inputs = fields.filter((f) => f.kind === "field");
  const firstEmpty = inputs.find((f) => f.empty);
  const complete = inputs.every((f) => !f.required || !f.empty) && inputs.some((f) => !f.empty);
  if (complete) return fields.find((f) => f.kind === "submit")?.id ?? firstEmpty?.id ?? null;
  return firstEmpty?.id ?? null;
}

// --- Reading the DOM -------------------------------------------------------------------------------

const FIELD = "input, textarea, select";

function isEmpty(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return !el.checked;
  return !(el as HTMLInputElement).value?.trim();
}

/** The control the form rule picks in each form that has dwell targets. */
export function formNextElements(scope: ParentNode): Set<Element> {
  const out = new Set<Element>();
  scope.querySelectorAll("form").forEach((form) => {
    const items: { el: Element; f: FormField }[] = [];
    form.querySelectorAll<HTMLElement>(`${FIELD}, [type=submit], button:not([type])`).forEach((el, i) => {
      if ((el as HTMLButtonElement).disabled && !el.matches(FIELD)) return;
      const submit = el.matches("button, input[type=submit]") && (el as HTMLButtonElement).type === "submit";
      const field = !submit && el.matches(FIELD);
      if (!submit && !field) return;
      items.push({
        el,
        f: {
          id: String(i),
          kind: submit ? "submit" : "field",
          empty: field ? isEmpty(el) : false,
          required: field && (el as HTMLInputElement).required,
        },
      });
    });
    const id = nextInForm(items.map((x) => x.f));
    const hit = items.find((x) => x.f.id === id);
    if (hit && hit.el.hasAttribute("data-dwell")) out.add(hit.el);
  });
  return out;
}

/** Context for a dwell target element. */
export function readContext(el: HTMLElement, formNext: Set<Element>): TargetContext {
  return contextFor({
    label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim(),
    likely: el.getAttribute("data-likely"),
    consequential: el.hasAttribute("data-consequential"),
    gate: el.hasAttribute("data-approval-gate"),
    protect: el.hasAttribute("data-protect") || el.hasAttribute("data-dwell-always"),
    formNext: formNext.has(el),
  });
}
