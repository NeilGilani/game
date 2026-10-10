import { useState } from "react";
import { api } from "../api/client";
import type { CaseDetail } from "../api/types";
import { useAnnounce } from "../state/announcer";
import { buildEvidenceReceipt, downloadReceipt } from "../state/evidence";
import { Icon } from "./Icon";

export function EvidenceReceipt({ data }: { data: CaseDetail }) {
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const verified = data.steps.filter((s) => s.status === "verified");
  const actions = verified.filter((s) => !s.read_only);
  const download = async () => {
    setBusy(true);
    try {
      // Fetch both fresh; don't export the screen's potentially stale snapshot.
      const [current, timeline] = await Promise.all([api.case(data.id), api.timeline(data.id)]);
      downloadReceipt(buildEvidenceReceipt(current, timeline));
      announce("Evidence receipt downloaded. It includes the recorded results, approvals, and checks.");
    } catch (e) {
      announce(e instanceof Error ? e.message : "Couldn't download the evidence receipt.", true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel evidence-receipt" aria-labelledby="receipt-heading">
      <span className="receipt-mark">
        <Icon name="shield" size={32} />
      </span>
      <div>
        <div className="eyebrow">Evidence you can keep</div>
        <h3 id="receipt-heading">
          {verified.length} steps verified. {actions.length} actions checked.
        </h3>
        <p className="small muted">
          Download the results, decisions, and service-record checks. Includes unfinished items and the
          demo-service disclosure.
        </p>
      </div>
      <button className="btn" onClick={() => void download()} disabled={busy} data-dwell>
        <Icon name="document" />
        {busy ? "Preparing receipt…" : "Download evidence"}
      </button>
    </section>
  );
}
