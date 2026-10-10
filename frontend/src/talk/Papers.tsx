/**
 * Papers: open a PDF, have it read aloud or explained, fill it from the profile, sign it
 * through the signing ceremony, and email it, each consequential step with approval.
 */

import { useRef, useState } from "react";
import type { LoadedDocument, SignatureStyle } from "../../../os/tasks/src/index";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import { Ceremony } from "./Ceremony";
import { useTalk } from "./services";
import { ApprovalPanel, Notes, PlanSteps, QuestionCards, ResultPanel } from "./TaskParts";
import { ScreenHead, SimNote } from "./ui";
import { useAgentTask } from "./useAgentTask";

/** Samples the host can offer (the harness and demos generate them; the app may not). */
export interface SampleDoc {
  id: string;
  name: string;
  make: () => Promise<Uint8Array>;
}

let docSeq = 0;

export function Papers({ samples = [] }: { samples?: SampleDoc[] }) {
  const { world, engine } = useTalk();
  const task = useAgentTask(world.agent);
  const [docs, setDocs] = useState<LoadedDocument[]>(() => world.documents.list());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState<SignatureStyle>("script");
  const fileRef = useRef<HTMLInputElement>(null);
  const { view } = task;

  const add = async (name: string, bytes: Uint8Array, source: LoadedDocument["source"]) => {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      docSeq += 1;
      const doc = await engine.load(`doc-${docSeq}`, name, bytes, source);
      world.documents.put(doc);
      setDocs(world.documents.list());
    } catch {
      setError(`AGENCY couldn't open "${name}". It may be damaged, password-protected or not a PDF.`);
    } finally {
      setBusy(false);
    }
  };

  const open = (doc: LoadedDocument) =>
    task.start({
      goal: `Papers: ${doc.name}`,
      origin: "talk",
      dryRun: true,
      selections: { pack: "documents", documentId: doc.id },
    });

  const current = view.taskId ? world.documents.get(view.approval?.preview?.data ?? "") : undefined;
  const summary =
    [...view.notes]
      .reverse()
      .find((n) => n.startsWith("Summary: "))
      ?.slice(9) ?? null;

  return (
    <div className="page talk-page" aria-label="Papers">
      <ScreenHead eyebrow="Papers" title={view.taskId ? view.goal.replace(/^Papers: /, "") : "Your papers"}>
        {view.taskId && !view.result ? (
          <button className="btn btn-solid-danger talk-btn" onClick={task.stop} data-dwell>
            <Icon name="stop" /> Stop
          </button>
        ) : (
          <button className="btn talk-btn btn-quiet" onClick={() => navigate("/")} data-dwell>
            <Icon name="home" /> Home
          </button>
        )}
      </ScreenHead>

      {!engine && (
        <SimNote>
          Papers needs the PDF engine, which this build of the app doesn't include yet. It works in the AGENCY
          test harness.
        </SimNote>
      )}

      {!view.taskId && engine && (
        <>
          <SimNote>Documents stay on this computer. Emails are simulated in this build.</SimNote>
          <div className="talk-tiles">
            {docs.slice(-4).map((d) => (
              <button key={d.id} className="tile talk-tile" onClick={() => open(d)} data-dwell>
                <span className="tile-icon">
                  <Icon name="document" size={28} />
                </span>
                <span className="tile-title">{d.name}</span>
                <span className="tile-sub">
                  {d.pageCount} page{d.pageCount === 1 ? "" : "s"}
                </span>
              </button>
            ))}
            <button
              className="tile talk-tile"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              data-dwell
            >
              <span className="tile-icon">
                <Icon name="plus" size={28} />
              </span>
              <span className="tile-title">{busy ? "Opening…" : "Open a PDF"}</span>
              <span className="tile-sub">A helper can choose a file</span>
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            aria-label="Choose a PDF"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await add(f.name, new Uint8Array(await f.arrayBuffer()), { kind: "file-picker" });
            }}
          />
          {samples.length > 0 && (
            <>
              <h2 className="talk-subhead">Sample documents (fictional)</h2>
              <div className="talk-row">
                {samples.map((s) => (
                  <button
                    key={s.id}
                    className="btn talk-btn"
                    onClick={async () => add(s.name, await s.make(), { kind: "sample" })}
                    disabled={busy}
                    data-dwell
                  >
                    <Icon name="document" /> {s.name}
                  </button>
                ))}
              </div>
            </>
          )}
          {error && (
            <p className="talk-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}

      {view.taskId && (
        <>
          {!view.question && !view.result && !view.approval && <PlanSteps steps={view.steps} />}
          <Notes notes={view.notes} />
          {view.question && (
            <QuestionCards
              question={view.question}
              onAnswer={(id, other) => {
                if (view.question?.prompt.startsWith("Choose how") && id) setStyle(id as SignatureStyle);
                task.answer(id, other);
              }}
            />
          )}
          {view.approval?.kind === "sign" && current ? (
            <Ceremony
              approval={view.approval}
              doc={current}
              engine={engine}
              summary={summary}
              style={style}
              onDecide={(d) => task.decide(d)}
            />
          ) : (
            view.approval && (
              <ApprovalPanel
                approval={view.approval}
                approveLabel={
                  view.approval.kind === "send"
                    ? "Send it"
                    : view.approval.kind === "share-personal-data"
                      ? "Yes, go ahead"
                      : "Approve"
                }
                onDecide={(d) => task.decide(d)}
              />
            )
          )}
          {view.result && (
            <ResultPanel
              result={view.result}
              onAgain={() => {
                task.reset();
                setDocs(world.documents.list());
              }}
              againLabel="Back to papers"
            />
          )}
        </>
      )}
    </div>
  );
}
