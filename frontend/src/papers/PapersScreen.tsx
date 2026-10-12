/**
 * Papers on the person's own documents (#/papers/explain, /fill, /sign): choose a document from the Papers folder
 * (Mac app) or one a helper opened (browser), then explain it, fill it in or sign it. Each consequential step goes
 * through the gate (gate.ts): the exact action is shown, approved, and only then done; Stop ends it at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STOP_ALL_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { host } from "../state/host";
import { navigate } from "../state/router";
import type { PaperFile } from "../../../os/contracts/src/host";
import { sha256Hex } from "../../../os/tasks/src/core/sha256";
import { pageTexts } from "../../../os/tasks/src/documents/pdf/papers";
import { PapersExplain } from "./PapersExplain";
import { PapersFill } from "./PapersFill";
import { PapersSign } from "./PapersSign";
import { PapersGate } from "./gate";
import { Bar, Choice, Choices, Head, Message, PageButtons, type OpenDoc } from "./parts";
import { imageUrl, pdfjsLib, renderPage } from "./pdf";
import { openFile, paperSource, papersMode, plainError, type PaperSource } from "./source";
import "./papers.css";

export type PapersAction = "explain" | "fill" | "sign";

const TITLES: Record<PapersAction, string> = {
  explain: "Which letter should AGENCY explain?",
  fill: "Which form do you want to fill in?",
  sign: "Which document do you want to sign?",
};

export function PapersScreen({ action }: { action: string }) {
  const mode = papersMode();
  const known = action === "explain" || action === "fill" || action === "sign";
  useEffect(() => {
    // Practice mode (the web demo, or no folder chosen yet) keeps the practice documents.
    if (mode === "practice" || !known) navigate("/flow/papers");
  }, [mode, known]);
  const source = useMemo(() => paperSource(), []);
  if (!known || !source) return null;
  return <PapersRun key={action} action={action} source={source} />;
}

function PapersRun({ action, source }: { action: PapersAction; source: PaperSource }) {
  const gate = useMemo(() => new PapersGate(), []);
  const announce = useAnnounce();
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [stopped, setStopped] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    if (gate.stopped) return;
    gate.stop();
    setStopped(true);
    announce("Stopped. Nothing more was done.", true);
  }, [gate, announce]);

  // Stop from anywhere: the dock's Stop agent, the overlay, the hotkey, the menu.
  useEffect(() => {
    window.addEventListener(STOP_ALL_EVENT, stop);
    const offHost = host()?.onStopAll(stop);
    return () => {
      window.removeEventListener(STOP_ALL_EVENT, stop);
      offHost?.();
    };
  }, [stop]);

  const open = async (file: PaperFile) => {
    setLoading(file.name);
    setError(null);
    try {
      const bytes = await source.read(file.name);
      const pages = file.kind === "pdf" ? await pageTexts(pdfjsLib, bytes) : [];
      if (gate.stopped) return;
      setDoc({ name: file.name, kind: file.kind, bytes, sha256: sha256Hex(bytes), pages });
    } catch (err) {
      setError(
        file.kind === "pdf"
          ? `AGENCY couldn't open "${file.name}". It may be damaged or locked with a password. ${plainError(err)}`.trim()
          : plainError(err),
      );
    } finally {
      setLoading(null);
    }
  };

  const back = () => {
    gate.reset();
    setDoc(null);
  };

  if (stopped)
    return (
      <Message
        eyebrow="Papers"
        title="Stopped. Nothing more was done."
        lines={["Anything already saved stays saved. Nothing was sent anywhere."]}
        onBack={() => {
          gate.reset();
          setStopped(false);
          setDoc(null);
        }}
      />
    );
  if (!doc) return <Pick action={action} source={source} onOpen={open} loading={loading} error={error} />;
  const props = { doc, gate, source, onBack: back, onStop: stop };
  if (action === "explain") return <PapersExplain {...props} />;
  if (action === "fill") return <PapersFill {...props} />;
  return <PapersSign {...props} />;
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const thumbs = new Map<string, Promise<string | null>>();

function Thumb({ source, file }: { source: PaperSource; file: PaperFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const key = `${source.kind}:${file.name}:${file.modifiedAt}`;
    let p = thumbs.get(key);
    if (!p) {
      p = source
        .read(file.name)
        .then((b) =>
          file.kind === "pdf" ? renderPage(b, 0, 240).then((r) => r.url) : imageUrl(b, file.name),
        )
        .catch(() => null);
      thumbs.set(key, p);
    }
    let live = true;
    void p.then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [source, file]);
  return url ? (
    <img className="papers-thumb" src={url} alt="" />
  ) : (
    <Icon name={file.kind === "pdf" ? "document" : "photo"} size={56} />
  );
}

const PER_PAGE = 4;

function Pick({
  action,
  source,
  onOpen,
  loading,
  error,
}: {
  action: PapersAction;
  source: PaperSource;
  onOpen: (f: PaperFile) => void;
  loading: string | null;
  error: string | null;
}) {
  const [files, setFiles] = useState<PaperFile[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [dropError, setDropError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    source.list().then(
      (all) => setFiles(all.filter((f) => action === "explain" || f.kind === "pdf")),
      (err: unknown) => setListError(plainError(err)),
    );
  }, [source, action]);
  useEffect(load, [load]);

  const add = async (list: FileList | null) => {
    setDropError(null);
    for (const f of Array.from(list ?? []).slice(0, 10)) {
      const problem = await openFile(f);
      if (problem) setDropError(problem);
    }
    load();
  };

  const picker = source.kind === "picker";
  const items = files ?? [];
  const slots = picker ? PER_PAGE - 1 : PER_PAGE;
  const pages = Math.max(1, Math.ceil(items.length / slots));
  const shown = items.slice(page * slots, page * slots + slots);
  const help = picker
    ? "A helper can open a document here, or drop it on this screen. It stays on this computer."
    : "Newest first, from the Papers folder a helper chose. Nothing leaves this computer unless you say so.";

  return (
    <div
      className="flow"
      aria-label="Papers"
      onDragOver={(e) => picker && e.preventDefault()}
      onDrop={(e) => {
        if (!picker) return;
        e.preventDefault();
        void add(e.dataTransfer.files);
      }}
    >
      <Head eyebrow="Papers" title={loading ? `Opening "${loading}"…` : TITLES[action]} help={help} />
      {listError ? (
        <div className="papers-panel" role="alert">
          <p>{listError}</p>
        </div>
      ) : files === null ? (
        <div className="flow-options flow-waiting" aria-busy="true">
          <p className="muted">Finding your documents…</p>
        </div>
      ) : items.length === 0 && !picker ? (
        <div className="papers-panel stack" role="status">
          <p className="task-big">
            There are no {action === "explain" ? "documents" : "PDFs"} in the Papers folder yet.
          </p>
          <p>
            A helper can save letters and forms (PDF, or photos for letters) into the folder chosen in
            Settings.
          </p>
        </div>
      ) : (
        <div className="stack papers-pick">
          <Choices count={shown.length + (picker ? 1 : 0)}>
            {picker && (
              <Choice
                label="Open a document"
                sub="A helper chooses a PDF or a photo"
                icon="plus"
                onPick={() => fileRef.current?.click()}
              />
            )}
            {shown.map((f) => (
              <Choice
                key={f.name}
                label={f.name.replace(/\.(pdf|png|jpe?g)$/i, "")}
                sub={`${f.kind === "pdf" ? "PDF" : "Photo"} · ${ago(f.modifiedAt)}`}
                pic={<Thumb source={source} file={f} />}
                onPick={() => !loading && onOpen(f)}
              />
            ))}
          </Choices>
          {(error || dropError) && (
            <p className="papers-error" role="alert">
              {error ?? dropError}
            </p>
          )}
          {picker && (
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={
                action === "explain"
                  ? ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                  : ".pdf,application/pdf"
              }
              className="sr-only"
              aria-label="Choose a document"
              onChange={(e) => {
                const list = e.target.files;
                void add(list).finally(() => (e.target.value = ""));
              }}
            />
          )}
        </div>
      )}
      <Bar>
        <PageButtons page={page} pages={pages} onPage={setPage} />
      </Bar>
    </div>
  );
}
