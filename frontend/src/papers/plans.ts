/**
 * What the person approves when filling or signing, built the same way when it's shown and when it's done, so the
 * gate's fingerprint (gate.ts) only matches the exact values, page, place and signature that were on screen.
 */
import { copyName, validAnswer, type FieldStep } from "../../../os/tasks/src/documents/fields";
import type { SignatureSpot } from "../../../os/tasks/src/documents/pdf/papers";
import type { Proposal } from "./gate";

/** The answers that change the form: only fields AGENCY may fill, only allowed values, only real changes. */
export function changedValues(
  steps: readonly FieldStep[],
  answers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps) {
    if (s.secret) continue;
    const v = answers[s.field.name];
    if (v === undefined || v === s.field.value || !validAnswer(s.field, v)) continue;
    out[s.field.name] = v;
  }
  return out;
}

export function shownValue(step: FieldStep, value: string | undefined): string {
  if (step.field.type === "checkbox") return value === "yes" ? "Ticked" : "Not ticked";
  return value?.trim() ? value : "Empty";
}

export function fillProposal(
  doc: { name: string; sha256: string },
  steps: readonly FieldStep[],
  answers: Record<string, string>,
): { proposal: Proposal; values: Record<string, string> } {
  const values = changedValues(steps, answers);
  const details: Record<string, string> = {
    "Saved as": `${copyName(doc.name, "filled")}, a new copy. The original stays as it is.`,
  };
  steps.forEach((s, i) => {
    if (s.field.name in values) details[`${i + 1}. ${s.field.label}`] = shownValue(s, values[s.field.name]);
  });
  return { proposal: { kind: "fill", document: doc.name, documentSha256: doc.sha256, details }, values };
}

export type SignatureChoice =
  | { kind: "saved"; sha256: string }
  /** The person's name, drawn in a script font and labelled as typed. */
  | { kind: "typed"; name: string };

export function signProposal(
  doc: { name: string; sha256: string },
  pageIndex: number,
  spot: SignatureSpot,
  signature: SignatureChoice,
  signerName: string,
): Proposal {
  const r = spot.rect;
  return {
    kind: "sign",
    document: doc.name,
    documentSha256: doc.sha256,
    details: {
      Page: `Page ${pageIndex + 1}`,
      Place: spot.label,
      "Exact place": `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      Signature:
        signature.kind === "saved"
          ? "Your saved signature picture"
          : `Your typed name, "${signature.name}", marked as a typed signature`,
      "Signature fingerprint": signature.kind === "saved" ? signature.sha256 : signature.name,
      "Signed by": signerName || "Not named (no name is saved)",
      "Saved as": `${copyName(doc.name, "signed")}, a new copy. The original stays as it is.`,
    },
  };
}
