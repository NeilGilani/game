/**
 * Where Papers gets the person's documents, and whether it works on real ones at all:
 *  - "folder": the Mac app, once a helper chose a Papers folder in Settings (main's narrow IPC, os/desktop papers.ts).
 *  - "picker": a plain browser, which has no file system access: a helper opens each document with the file picker
 *    or drops it on the screen, and a filled or signed copy is downloaded.
 *  - "practice": the hosted web demo, and the Mac app before a folder is chosen: the fictional practice documents.
 */
import type { PaperFile, PapersApi, PapersFolder } from "../../../os/contracts/src/host";
import { fakeForced, host } from "../state/host";

export type PapersMode = "folder" | "picker" | "practice";

export interface PaperSource {
  kind: "folder" | "picker";
  list(): Promise<PaperFile[]>;
  read(name: string): Promise<Uint8Array>;
  /** Save a new copy next to the original (never over it). `where` says where it went, in plain words. */
  save(
    original: string,
    suffix: "filled" | "signed",
    bytes: Uint8Array,
  ): Promise<{ name: string; where: string }>;
}

/** The same limits as the Mac app's (os/desktop/src/main/papers.ts). */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const KINDS: Record<string, PaperFile["kind"]> = { pdf: "pdf", png: "image", jpg: "image", jpeg: "image" };

export function kindOf(name: string): PaperFile["kind"] | null {
  return KINDS[name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** The Mac app's Papers API, when this build of the app has it. */
export function papersApi(): PapersApi | null {
  if (!host()) return null;
  return (window as unknown as { agency?: { papers?: PapersApi } }).agency?.papers ?? null;
}

let folder: PapersFolder | null = null;
let folderListeners: (() => void)[] = [];

/** The chosen folder as main last reported it (null: none, or not in the Mac app). */
export function currentFolder(): PapersFolder | null {
  return folder;
}

export function setCurrentFolder(f: PapersFolder | null): void {
  folder = f;
  for (const l of folderListeners) l();
}

export function onFolderChange(l: () => void): () => void {
  folderListeners.push(l);
  return () => {
    folderListeners = folderListeners.filter((x) => x !== l);
  };
}

export async function refreshFolder(): Promise<PapersFolder | null> {
  const api = papersApi();
  if (!api) return null;
  try {
    setCurrentFolder(await api.folder());
  } catch {
    /* keep what was known */
  }
  return folder;
}

// Ask main once at start, so the Papers flow knows before the person gets there.
if (typeof window !== "undefined") void refreshFolder();

function webDemo(): boolean {
  return import.meta.env.VITE_WEB_DEMO === "1";
}

export function papersMode(): PapersMode {
  if (typeof window === "undefined" || webDemo() || fakeForced("papers")) return "practice";
  if (!host()) return "picker";
  return papersApi() && folder ? "folder" : "practice";
}

/** Plain-browser documents: the ones a helper opened on this page, kept only while the page is open. */
const opened = new Map<string, { bytes: Uint8Array; file: PaperFile }>();

/** A helper chose or dropped a file. Returns a sentence when it can't be used. */
export async function openFile(file: File): Promise<string | null> {
  const kind = kindOf(file.name);
  if (!kind) return `"${file.name}" isn't a PDF, PNG or JPEG, so Papers can't open it.`;
  if (file.size > MAX_FILE_BYTES) return `"${file.name}" is too big for Papers (over 30 MB).`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.replace(/[/\\]/g, "_");
  opened.set(name, {
    bytes,
    file: {
      name,
      size: file.size,
      modifiedAt: new Date(file.lastModified || Date.now()).toISOString(),
      kind,
    },
  });
  return null;
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function copyName(original: string, suffix: string, taken: (n: string) => boolean): string {
  const stem = original.replace(/\.pdf$/i, "");
  for (let n = 1; ; n++) {
    const name = `${stem}-${suffix}${n === 1 ? "" : `-${n}`}.pdf`;
    if (!taken(name)) return name;
  }
}

export function pickerSource(): PaperSource {
  return {
    kind: "picker",
    list: async () =>
      [...opened.values()].map((o) => o.file).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    read: async (name) => {
      const o = opened.get(name);
      if (!o) throw new Error(`"${name}" isn't open any more. Open it again.`);
      return o.bytes;
    },
    save: async (original, suffix, bytes) => {
      const name = copyName(original, suffix, (n) => opened.has(n));
      download(name, bytes);
      return { name, where: "your browser's downloads" };
    },
  };
}

/** Errors from main arrive as "Error invoking remote method 'agency:papers': Error: <sentence>". */
export function plainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

export function folderSource(api: PapersApi): PaperSource {
  return {
    kind: "folder",
    list: () => api.list(),
    read: async (name) => new Uint8Array(await api.read(name)),
    save: async (original, suffix, bytes) => ({
      ...(await api.saveCopy(original, suffix, bytes)),
      where: `next to the original in ${folder?.display ?? "the Papers folder"}`,
    }),
  };
}

/** The source for this mode, or null in practice mode. */
export function paperSource(): PaperSource | null {
  const mode = papersMode();
  if (mode === "picker") return pickerSource();
  const api = papersApi();
  return mode === "folder" && api ? folderSource(api) : null;
}
