/**
 * Sign a document in one place: choose the page, then one of a few big places on it, then the signature (the saved
 * picture, or the typed name in a script font, clearly marked as typed). Then two separate yeses: the first names
 * the document and says what signing means, the second (on the other side of the screen, after a moment) signs.
 * A new "...-signed.pdf" is saved next to the original and read back: only that page changed, in that one place.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { sha256Hex } from "../../../os/tasks/src/core/sha256";
import { copyName } from "../../../os/tasks/src/documents/fields";
import { WHAT_SIGNING_MEANS } from "../../../os/tasks/src/documents/understand";
import {
  checkSigned,
  signatureSpots,
  stampSignature,
  type SignatureSpot,
  type StampRequest,
} from "../../../os/tasks/src/documents/pdf/papers";
import { checkSignable } from "../../../os/tasks/src/policy/documents";
import { GateRefused } from "./gate";
import {
  Bar,
  Choice,
  Choices,
  Head,
  Message,
  PageButtons,
  Saved,
  SecondConfirm,
  type FlowProps,
} from "./parts";
import { pdfjsLib, renderPage, typedSignaturePng, type PagePicture } from "./pdf";
import { signProposal, type SignatureChoice } from "./plans";
import { plainError } from "./source";
import { dataUrlBytes, loadDetails, loadSignature } from "./store";

type Stage =
  | { type: "page"; page: number }
  | { type: "spot"; pageIndex: number }
  | { type: "signature"; pageIndex: number; spot: SignatureSpot }
  | { type: "type-name"; pageIndex: number; spot: SignatureSpot }
  | { type: "confirm"; pageIndex: number; spot: SignatureSpot; signature: SignatureChoice; signer: string }
  | {
      type: "reconfirm";
      pageIndex: number;
      spot: SignatureSpot;
      signature: SignatureChoice;
      signer: string;
      fp: string;
    }
  | { type: "signing" }
  | { type: "saved"; name: string; where: string; page: number }
  | { type: "failed"; message: string };

function pageCount(doc: FlowProps["doc"]): number {
  return doc.pages.length;
}

export function PapersSign(props: FlowProps) {
  const { doc } = props;
  if (doc.kind !== "pdf")
    return (
      <Message
        eyebrow="Sign a document"
        title="AGENCY can sign PDFs only"
        lines={["This is a photo. A helper can save it as a PDF first."]}
        onBack={props.onBack}
      />
    );
  // Some documents can't be signed this way at all (wills, powers of attorney, notarised papers...).
  const refusal = checkSignable(doc.pages.join("\n"));
  if (refusal)
    return (
      <Message
        eyebrow="Sign a document"
        title={`${refusal.title}. AGENCY won't sign it.`}
        lines={[refusal.why, `What to do instead: ${refusal.properRoute}`]}
        onBack={props.onBack}
      />
    );
  return <SignSteps {...props} />;
}

function SignSteps({ doc, gate, source, onBack, onStop }: FlowProps) {
  const pages = pageCount(doc);
  const [stage, setStage] = useState<Stage>(
    pages > 1 ? { type: "page", page: 0 } : { type: "spot", pageIndex: 0 },
  );
  const details = loadDetails();
  const saved = loadSignature();

  const sign = async (s: Extract<Stage, { type: "reconfirm" }>) => {
    const proposal = signProposal(doc, s.pageIndex, s.spot, s.signature, s.signer);
    setStage({ type: "signing" });
    try {
      const result = await gate.perform(proposal, async () => {
        if (s.signature.kind === "saved" && (!saved || sha256Hex(saved) !== s.signature.sha256))
          throw new Error("The saved signature changed. Choose it again.");
        const image =
          s.signature.kind === "saved"
            ? dataUrlBytes(saved!)
            : ((await typedSignaturePng(s.signature.name)) ?? undefined);
        const req: StampRequest = {
          pageIndex: s.pageIndex,
          rect: s.spot.rect,
          ...(image ? { image } : {}),
          ...(s.signature.kind === "typed" ? { typedName: s.signature.name } : {}),
          signerName: s.signer,
          signedAt: new Date().toISOString(),
          documentSha256: doc.sha256,
        };
        const out = await stampSignature(doc.bytes, req);
        // Read it back: only the chosen page changed, with exactly one signature.
        const check = await checkSigned(pdfjsLib, doc.bytes, out, req);
        if (!check.ok)
          throw new Error(`The signed copy didn't check out (${check.problem}), so it wasn't saved.`);
        gate.check();
        return source.save(doc.name, "signed", out);
      });
      setStage({ type: "saved", ...result, page: s.pageIndex });
    } catch (err) {
      if (gate.stopped) return;
      setStage({ type: "failed", message: err instanceof GateRefused ? err.message : plainError(err) });
    }
  };

  if (stage.type === "failed")
    return (
      <Message eyebrow="Sign a document" title="It wasn't signed" lines={[stage.message]} onBack={onBack} />
    );
  if (stage.type === "saved")
    return (
      <Saved
        title="Signed and saved. A caregiver can send it."
        lines={[
          `Saved as "${stage.name}" ${stage.where}. Only page ${stage.page + 1} was signed, in the one place you chose.`,
          `The original "${doc.name}" stays as it was. Nothing was sent to anyone.`,
        ]}
      />
    );
  if (stage.type === "signing")
    return (
      <div className="flow" aria-label="Papers">
        <Head eyebrow="Sign a document" title="Signing and checking it…" />
        <div className="flow-options flow-waiting" aria-busy="true" />
        <Bar onBack={onBack} onStop={onStop} />
      </div>
    );
  if (stage.type === "page")
    return <ChoosePage doc={doc} stage={stage} setStage={setStage} onBack={onBack} onStop={onStop} />;
  if (stage.type === "spot")
    return (
      <ChooseSpot
        doc={doc}
        pageIndex={stage.pageIndex}
        onPick={(spot) => setStage({ type: "signature", pageIndex: stage.pageIndex, spot })}
        onBack={() =>
          pages > 1 ? setStage({ type: "page", page: Math.floor(stage.pageIndex / 4) }) : onBack()
        }
        onStop={onStop}
      />
    );
  if (stage.type === "type-name")
    return (
      <div className="flow" aria-label="Papers">
        <Head eyebrow="Sign a document" title="Type your name as you sign it" />
        <form
          className="flow-type"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
            if (name)
              setStage({ ...stage, type: "confirm", signature: { kind: "typed", name }, signer: name });
          }}
        >
          <label className="field">
            <span className="sr-only">Your name</span>
            <input name="name" maxLength={80} autoFocus autoComplete="off" />
          </label>
          <button className="btn btn-xl btn-primary" type="submit" data-dwell>
            <Icon name="check" /> Done
          </button>
        </form>
        <Bar onBack={() => setStage({ ...stage, type: "signature" })} onStop={onStop} />
      </div>
    );
  if (stage.type === "signature") {
    const name = details?.fullName ?? "";
    const opts: { key: string; label: string; sub: string; pic?: ReactNode; choose: () => void }[] = [];
    if (saved)
      opts.push({
        key: "saved",
        label: "Your saved signature",
        sub: name ? `As ${name}` : "The picture a helper saved",
        pic: <img className="papers-signature" src={saved} alt="" />,
        choose: () =>
          setStage({
            ...stage,
            type: "confirm",
            signature: { kind: "saved", sha256: sha256Hex(saved) },
            signer: name,
          }),
      });
    if (name)
      opts.push({
        key: "typed",
        label: `Your typed name: ${name}`,
        sub: "In a handwriting-style font, marked as a typed signature",
        pic: <span className="papers-typed">{name}</span>,
        choose: () =>
          setStage({ ...stage, type: "confirm", signature: { kind: "typed", name }, signer: name }),
      });
    opts.push({
      key: "type",
      label: name ? "Type a different name" : "Type your name",
      sub: "With the keyboard. Marked as a typed signature",
      choose: () => setStage({ ...stage, type: "type-name" }),
    });
    return (
      <div className="flow" aria-label="Papers">
        <Head
          eyebrow={`Sign a document · page ${stage.pageIndex + 1}`}
          title="Which signature?"
          help={
            saved || name
              ? undefined
              : "No signature or name is saved yet. A helper can add them in Settings, Papers."
          }
        />
        <Choices count={opts.length}>
          {opts.map((o) => (
            <Choice key={o.key} label={o.label} sub={o.sub} icon="edit" pic={o.pic} onPick={o.choose} />
          ))}
        </Choices>
        <Bar onBack={() => setStage({ type: "spot", pageIndex: stage.pageIndex })} onStop={onStop} />
      </div>
    );
  }

  // The two confirmations.
  const proposal = signProposal(doc, stage.pageIndex, stage.spot, stage.signature, stage.signer);
  const what =
    stage.signature.kind === "saved"
      ? "your saved signature"
      : `your typed name, "${stage.signature.name}" (marked as typed)`;
  return (
    <div className="flow" aria-label="Papers" data-testid={`papers-sign-${stage.type}`}>
      <Head
        eyebrow="Sign a document"
        title={
          stage.type === "confirm"
            ? `You are about to sign "${doc.name}"`
            : `Last check: sign "${doc.name}" now?`
        }
        help={`On page ${stage.pageIndex + 1}, ${stage.spot.label[0]!.toLowerCase()}${stage.spot.label.slice(1)}, with ${what}. Only this one place is signed. A new copy, "${copyName(doc.name, "signed")}", is saved; the original stays as it is.`}
      />
      {stage.type === "confirm" ? (
        <div className="papers-sign-confirm">
          <div className="papers-panel stack">
            <h2>What signing means</h2>
            <ul className="papers-meaning">
              {WHAT_SIGNING_MEANS.slice(0, 2).map((m) => (
                <li key={m}>{m}</li>
              ))}
              <li>AGENCY saves the signed copy. It doesn't send it; a helper can.</li>
              <li>{WHAT_SIGNING_MEANS[3]}</li>
            </ul>
          </div>
          <div className="papers-sign-buttons">
            <button
              className="btn btn-xl btn-primary"
              onClick={() => setStage({ ...stage, type: "reconfirm", fp: gate.propose(proposal) })}
              data-dwell
              data-approval-gate
            >
              <Icon name="check" /> Yes, I want to sign
            </button>
            <button className="btn btn-xl" onClick={onBack} data-dwell>
              <Icon name="x" /> Don't sign
            </button>
          </div>
        </div>
      ) : (
        <SecondConfirm
          side="left"
          question={`Sign "${doc.name}" on page ${stage.pageIndex + 1}${stage.signer ? ` as ${stage.signer}` : ""}?`}
          yes="Sign it now"
          onNo={() => setStage({ ...stage, type: "confirm" })}
          onYes={() => {
            if (gate.approve(stage.fp)) void sign(stage);
          }}
        />
      )}
      <Bar
        onBack={() => setStage({ type: "signature", pageIndex: stage.pageIndex, spot: stage.spot })}
        onStop={onStop}
      />
    </div>
  );
}

function usePicture(bytes: Uint8Array, pageIndex: number, px: number): PagePicture | null {
  const [pic, setPic] = useState<PagePicture | null>(null);
  useEffect(() => {
    let live = true;
    renderPage(bytes, pageIndex, px).then(
      (p) => live && setPic(p),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bytes, pageIndex, px]);
  return pic;
}

function PageThumb({ bytes, pageIndex }: { bytes: Uint8Array; pageIndex: number }) {
  const pic = usePicture(bytes, pageIndex, 200);
  return pic ? <img className="papers-thumb" src={pic.url} alt="" /> : <Icon name="document" size={56} />;
}

function ChoosePage({
  doc,
  stage,
  setStage,
  onBack,
  onStop,
}: {
  doc: FlowProps["doc"];
  stage: Extract<Stage, { type: "page" }>;
  setStage: (s: Stage) => void;
  onBack: () => void;
  onStop: () => void;
}) {
  const count = pageCount(doc);
  const per = 4;
  const pages = Math.ceil(count / per);
  const shown = Array.from({ length: count }, (_, i) => i).slice(stage.page * per, stage.page * per + per);
  return (
    <div className="flow" aria-label="Papers">
      <Head
        eyebrow={`Sign a document · "${doc.name}"`}
        title="Which page do you sign?"
        help={`It has ${count} pages.`}
      />
      <Choices count={shown.length}>
        {shown.map((i) => (
          <Choice
            key={i}
            label={`Page ${i + 1}`}
            sub={/\bsign/i.test(doc.pages[i] ?? "") ? "Mentions signing" : undefined}
            pic={<PageThumb bytes={doc.bytes} pageIndex={i} />}
            onPick={() => setStage({ type: "spot", pageIndex: i })}
          />
        ))}
      </Choices>
      <Bar onBack={onBack} onStop={onStop}>
        <PageButtons page={stage.page} pages={pages} onPage={(p) => setStage({ type: "page", page: p })} />
      </Bar>
    </div>
  );
}

function ChooseSpot({
  doc,
  pageIndex,
  onPick,
  onBack,
  onStop,
}: {
  doc: FlowProps["doc"];
  pageIndex: number;
  onPick: (s: SignatureSpot) => void;
  onBack: () => void;
  onStop: () => void;
}) {
  const [spots, setSpots] = useState<SignatureSpot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pic = usePicture(doc.bytes, pageIndex, 480);
  useEffect(() => {
    let live = true;
    signatureSpots(pdfjsLib, doc.bytes, pageIndex).then(
      (s) => live && setSpots(s),
      (err: unknown) => live && setError(plainError(err)),
    );
    return () => {
      live = false;
    };
  }, [doc.bytes, pageIndex]);
  if (error)
    return (
      <Message
        eyebrow="Sign a document"
        title="AGENCY couldn't read this page"
        lines={[error]}
        onBack={onBack}
      />
    );
  return (
    <div className="flow" aria-label="Papers">
      <Head eyebrow={`Sign a document · page ${pageIndex + 1}`} title="Where should the signature go?" />
      <div className="papers-spot-layout">
        <figure className="papers-page" aria-label={`Page ${pageIndex + 1}, with the places numbered`}>
          {pic && <img src={pic.url} alt="" />}
          {pic &&
            spots?.map((s, i) => (
              <span
                key={s.id}
                className="papers-spot-box"
                style={{
                  left: `${(s.rect.x / pic.width) * 100}%`,
                  top: `${(1 - (s.rect.y + s.rect.height) / pic.height) * 100}%`,
                  width: `${(s.rect.width / pic.width) * 100}%`,
                  height: `${(s.rect.height / pic.height) * 100}%`,
                }}
                aria-hidden
              >
                {i + 1}
              </span>
            ))}
        </figure>
        {spots ? (
          <div className="papers-spot-choices" role="group" aria-labelledby="papers-title">
            {spots.map((s, i) => (
              <button key={s.id} className="choice papers-spot-choice" onClick={() => onPick(s)} data-dwell>
                <span className="papers-spot-num" aria-hidden>
                  {i + 1}
                </span>
                <span className="choice-label">{s.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted" aria-busy="true">
            Finding places to sign…
          </p>
        )}
      </div>
      <Bar onBack={onBack} onStop={onStop} />
    </div>
  );
}
