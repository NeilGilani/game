/** Documents and signatures: the shapes shared by the pack, the PDF engine and the Papers screens. */

export interface FormField {
  name: string;
  type: "text" | "checkbox" | "signature" | "other";
  value?: string;
  /** Zero-based page index of the field's first widget, when known. */
  page?: number;
}

export interface LoadedDocument {
  id: string;
  name: string;
  bytes: Uint8Array;
  /** SHA-256 of the exact bytes, hex. Shown on the signing certificate. */
  sha256: string;
  pageCount: number;
  /** Extracted text per page. Untrusted data: shown and read aloud, never followed. */
  pages: string[];
  fields: FormField[];
  source: DocumentSource;
}

export type DocumentSource =
  | { kind: "file-picker" }
  | { kind: "sample" }
  | { kind: "downloads"; path: string }
  | { kind: "mail"; from: string; subject: string }
  | { kind: "browser"; url: string };

export type SignatureStyle = "script" | "classic" | "print";

export const SIGNATURE_STYLES: { id: SignatureStyle; label: string }[] = [
  { id: "script", label: "Slanted, like handwriting" },
  { id: "classic", label: "Classic serif" },
  { id: "print", label: "Plain print" },
];

export interface SignatureRequest {
  signerName: string;
  style: SignatureStyle;
  /** The statement the person confirmed, printed on the certificate. */
  intent: string;
  /** ISO time of the final confirmation. */
  signedAt: string;
  /** SHA-256 of the document as it was reviewed (before signing). */
  documentSha256: string;
  documentName: string;
  pageCount: number;
}

/** Turns bytes into pages, text and fields; fills fields; applies a signature and certificate. */
export interface DocumentEngine {
  load(id: string, name: string, bytes: Uint8Array, source: DocumentSource): Promise<LoadedDocument>;
  fill(bytes: Uint8Array, values: Record<string, string>): Promise<Uint8Array>;
  sign(bytes: Uint8Array, request: SignatureRequest): Promise<Uint8Array>;
  /** Browser only: a page as a PNG data URL for the viewer. */
  renderPage?(bytes: Uint8Array, pageIndex: number, width: number): Promise<string>;
}

/** Where imported and signed documents live (in memory by default; nothing leaves the Mac). */
export interface DocumentStore {
  put(doc: LoadedDocument): void;
  get(id: string): LoadedDocument | undefined;
  list(): LoadedDocument[];
  saveSigned(id: string, name: string, bytes: Uint8Array): { savedAs: string };
  signed(id: string): { name: string; bytes: Uint8Array } | undefined;
}

export class MemoryDocumentStore implements DocumentStore {
  private readonly docs = new Map<string, LoadedDocument>();
  private readonly signedDocs = new Map<string, { name: string; bytes: Uint8Array }>();
  put(doc: LoadedDocument): void {
    this.docs.set(doc.id, doc);
  }
  get(id: string): LoadedDocument | undefined {
    return this.docs.get(id);
  }
  list(): LoadedDocument[] {
    return [...this.docs.values()];
  }
  saveSigned(id: string, name: string, bytes: Uint8Array): { savedAs: string } {
    this.signedDocs.set(id, { name, bytes });
    return { savedAs: name };
  }
  signed(id: string): { name: string; bytes: Uint8Array } | undefined {
    return this.signedDocs.get(id);
  }
}

export function signedName(name: string): string {
  return name.replace(/(\.pdf)?$/i, " (signed).pdf");
}
