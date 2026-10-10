/**
 * The signing ceremony. Shown in place of an ordinary approval when the documents pack asks
 * to sign. Every page, the summary, what signing means, the signature, the intent statement,
 * then two confirmations: a long dwell (three times the usual dwell), then a second confirm on
 * the other side of the screen. "Don't sign" is on every step; nothing is timed.
 */

import { useEffect, useReducer, useState } from "react";
import type { ApprovalRequest } from "../../../os/contracts/src/agent";
import {
  ESIGN_NOTE,
  LONG_DWELL_SCALE,
  WHAT_SIGNING_MEANS,
  allPagesSeen,
  canAdvance,
  ceremonyReducer,
  quickFacts,
  startCeremony,
  type DocumentEngine,
  type LoadedDocument,
  type SignatureStyle,
} from "../../../os/tasks/src/index";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";

const STYLE_CLASS: Record<SignatureStyle, string> = {
  script: "sig-script",
  classic: "sig-classic",
  print: "sig-print",
};

function PageView({
  doc,
  index,
  engine,
}: {
  doc: LoadedDocument;
  index: number;
  engine: DocumentEngine | null;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    engine
      ?.renderPage?.(doc.bytes, index, 900)
      .then((s) => live && setSrc(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [doc, index, engine]);
  return (
    <figure className="cer-page">
      {src ? (
        <img src={src} alt={`Page ${index + 1} of ${doc.name}`} />
      ) : (
        <pre className="cer-page-text">{doc.pages[index] || "(This page has no readable text.)"}</pre>
      )}
      <figcaption>
        Page {index + 1} of {doc.pageCount}
      </figcaption>
    </figure>
  );
}

export function Ceremony({
  approval,
  doc,
  engine,
  summary,
  style,
  onDecide,
}: {
  approval: ApprovalRequest;
  doc: LoadedDocument;
  engine: DocumentEngine | null;
  summary: string | null;
  style: SignatureStyle;
  onDecide: (d: "approve" | "decline") => void;
}) {
  const [s, dispatch] = useReducer(ceremonyReducer, doc.pageCount, (n) => startCeremony(n, "right"));
  const [pageIndex, setPageIndex] = useState(0);
  const signer = approval.details["Signed by"] ?? "";
  const intent = approval.details["Your statement"] ?? "";

  useEffect(() => {
    if (s.stage === "pages") dispatch({ type: "saw-page", index: pageIndex });
  }, [pageIndex, s.stage]);
  useEffect(() => {
    // New choices under the gaze: pause selection briefly.
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    if (s.stage === "approved") onDecide("approve");
  }, [s.stage, onDecide]);

  const back = (
    <button
      className="btn talk-btn btn-quiet"
      onClick={() => dispatch({ type: "back" })}
      disabled={s.stage === "pages"}
      data-dwell
    >
      <Icon name="back" /> Back
    </button>
  );
  const dontSign = (
    <button className="btn talk-btn btn-danger" onClick={() => onDecide("decline")} data-dwell>
      <Icon name="x" /> Don't sign
    </button>
  );
  const next = (label: string) => (
    <button
      className="btn btn-primary talk-btn"
      onClick={() => dispatch({ type: "next" })}
      disabled={!canAdvance(s)}
      data-dwell
    >
      {label} <Icon name="right" />
    </button>
  );

  return (
    <section className="cer" aria-label="Signing">
      <div
        className="cer-progress"
        aria-label={`Step ${["pages", "summary", "meaning", "adopt", "intent", "confirm", "reconfirm"].indexOf(s.stage) + 1} of 7`}
      >
        {["Pages", "Summary", "Meaning", "Signature", "Statement", "Confirm", "Confirm again"].map(
          (label, i) => (
            <span
              key={label}
              className={`cer-dot ${i === ["pages", "summary", "meaning", "adopt", "intent", "confirm", "reconfirm"].indexOf(s.stage) ? "cer-dot-now" : ""}`}
            >
              {label}
            </span>
          ),
        )}
      </div>

      {s.stage === "pages" && (
        <>
          <h2>Look at every page before you sign</h2>
          <PageView doc={doc} index={pageIndex} engine={engine} />
          <div className="talk-row">
            {dontSign}
            <span className="spacer" />
            <button
              className="btn talk-btn"
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
              disabled={pageIndex === 0}
              data-dwell
            >
              <Icon name="left" /> Previous page
            </button>
            {pageIndex < doc.pageCount - 1 ? (
              <button
                className="btn btn-primary talk-btn"
                onClick={() => setPageIndex((i) => i + 1)}
                data-dwell
              >
                Next page <Icon name="right" />
              </button>
            ) : (
              next(allPagesSeen(s) ? "I've seen every page" : "See every page first")
            )}
          </div>
        </>
      )}

      {s.stage === "summary" && (
        <>
          <h2>What this document says</h2>
          {summary ? (
            <p className="cer-big">{summary}</p>
          ) : (
            <>
              <p className="talk-muted">Quick facts, found by AGENCY without AI:</p>
              <ul className="talk-list">
                {quickFacts(doc).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
          <div className="talk-row">
            {dontSign}
            <span className="spacer" />
            {back}
            {next("Next")}
          </div>
        </>
      )}

      {s.stage === "meaning" && (
        <>
          <h2>What signing means</h2>
          <ul className="talk-list cer-big">
            {WHAT_SIGNING_MEANS.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="talk-muted">{ESIGN_NOTE}</p>
          <div className="talk-row">
            {dontSign}
            <span className="spacer" />
            {back}
            {next("I understand")}
          </div>
        </>
      )}

      {s.stage === "adopt" && (
        <>
          <h2>This is your signature</h2>
          <button
            className={`cer-signature ${STYLE_CLASS[style]}`}
            aria-pressed={s.style !== null}
            onClick={() => dispatch({ type: "adopt", style })}
            data-dwell
          >
            {signer}
            <span className="cer-signature-hint">{s.style ? "Adopted" : "Look here to adopt it"}</span>
          </button>
          <div className="talk-row">
            {dontSign}
            <span className="spacer" />
            {back}
            {next("Next")}
          </div>
        </>
      )}

      {s.stage === "intent" && (
        <>
          <h2>Your statement</h2>
          <blockquote className="cer-intent">{intent}</blockquote>
          <p className="talk-muted">
            This statement, the time, and the document's fingerprint go on a certificate page added at the
            end.
          </p>
          <div className="talk-row">
            {dontSign}
            <span className="spacer" />
            {back}
            {next("Next")}
          </div>
        </>
      )}

      {s.stage === "confirm" && (
        <>
          <h2>Ready to sign?</h2>
          <p className="cer-big">
            Look at the green button and keep looking until it fills. This takes longer on purpose.
          </p>
          <div className="cer-confirm-row cer-confirm-right">
            <div className="talk-col">
              {back}
              {dontSign}
            </div>
            <button
              className="btn btn-primary cer-confirm"
              data-dwell
              data-dwell-scale={LONG_DWELL_SCALE}
              onClick={() => dispatch({ type: "confirmed" })}
            >
              <Icon name="check" size={34} /> Sign “{doc.name}”
            </button>
          </div>
        </>
      )}

      {s.stage === "reconfirm" && (
        <>
          <h2>One more time, to be sure</h2>
          <p className="cer-big">You're signing as {signer}. This can't easily be undone.</p>
          <div className={`cer-confirm-row cer-confirm-${s.reconfirmSide}`}>
            <button
              className="btn btn-primary cer-confirm"
              data-dwell
              onClick={() => dispatch({ type: "reconfirmed" })}
            >
              <Icon name="check" size={34} /> Yes, sign it now
            </button>
            <div className="talk-col">
              {back}
              {dontSign}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
