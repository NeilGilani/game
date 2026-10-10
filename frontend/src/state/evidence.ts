import type { CaseDetail, Timeline } from "../api/types";

/** Preserve actual statuses, including failures and unfinished work. No inferred outcomes. */
export function buildEvidenceReceipt(data: CaseDetail, timeline: Timeline) {
  const verified = data.steps.filter((s) => s.status === "verified");
  return {
    format: "agency.evidence.v1",
    exported_at: new Date().toISOString(),
    disclosure:
      "Workflow integrations are simulated demo services. This receipt does not prove a real-world booking, payment, or message delivery.",
    snapshot_note:
      "Case and audit records were fetched separately. An active workflow may advance between reads; each record retains its own status and timestamp.",
    metrics: {
      steps_verified: verified.length,
      actions_verified: verified.filter((s) => !s.read_only).length,
      recovery_steps_verified: verified.filter((s) => !!s.recovery_of).length,
      approved_decisions: timeline.approvals.filter((a) => a.status === "approved").length,
      passing_verification_records: timeline.verifications.filter((v) => v.passed).length,
    },
    case: data,
    audit: timeline,
  };
}

export function downloadReceipt(receipt: ReturnType<typeof buildEvidenceReceipt>): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `agency-${receipt.case.id}-evidence.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
