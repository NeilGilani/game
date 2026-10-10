/**
 * The PDF document engine: pdf.js reads text and renders pages; pdf-lib fills fields,
 * applies the typed signature and appends the audit certificate page.
 *
 * pdf.js is injected so each host loads the right build: the browser build with its worker
 * in the renderer, the legacy build in Node (tests, the agent's utility process).
 */

import {
  PDFCheckBox,
  PDFDocument,
  PDFName,
  PDFSignature,
  PDFTextField,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { sha256Hex } from "../../core/sha256";
import { ESIGN_NOTE } from "../../policy/documents";
import { CERTIFICATE_TITLE, EYE_GAZE_LINE } from "./constants";
import type { DocumentEngine, DocumentSource, FormField, LoadedDocument, SignatureRequest } from "../types";

/** The slice of pdf.js used here (getDocument → pages → text content / render). */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean }): {
    promise: Promise<PdfJsDocument>;
  };
}
interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfJsPage>;
  destroy(): Promise<void>;
}
interface PdfJsPage {
  getTextContent(): Promise<{ items: unknown[] }>;
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas?: HTMLCanvasElement }): {
    promise: Promise<void>;
  };
}

export { CERTIFICATE_TITLE, EYE_GAZE_LINE };

/** pdf-lib's standard fonts only encode WinAnsi; replace what they can't draw. */
export function winAnsi(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7e\xa0-\xff\n]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}

function textOf(items: unknown[]): string {
  let out = "";
  for (const item of items) {
    const i = item as { str?: string; hasEOL?: boolean };
    if (typeof i.str !== "string") continue;
    out += i.str;
    out += i.hasEOL ? "\n" : " ";
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function readFields(pdf: PDFDocument): Promise<FormField[]> {
  const pages = pdf.getPages();
  const pageIndex = (ref: unknown) => pages.findIndex((p) => p.ref === ref);
  return pdf
    .getForm()
    .getFields()
    .map((f) => {
      const widget = f.acroField.getWidgets()[0];
      const pRef = widget?.P();
      const page = pRef ? pageIndex(pRef) : -1;
      const base = { name: f.getName(), ...(page >= 0 ? { page } : {}) };
      if (f instanceof PDFTextField) return { ...base, type: "text" as const, value: f.getText() ?? "" };
      if (f instanceof PDFCheckBox)
        return { ...base, type: "checkbox" as const, value: f.isChecked() ? "yes" : "" };
      if (f instanceof PDFSignature) return { ...base, type: "signature" as const };
      return { ...base, type: "other" as const };
    });
}

/** Where to draw the signature: a signature field, a text field named like "signature", or the last page. */
function signatureSpot(pdf: PDFDocument): {
  page: PDFPage;
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const pages = pdf.getPages();
  for (const f of pdf.getForm().getFields()) {
    const isSig = f instanceof PDFSignature || (f instanceof PDFTextField && /sign/i.test(f.getName()));
    if (!isSig) continue;
    const widget = f.acroField.getWidgets()[0];
    if (!widget) continue;
    const r = widget.getRectangle();
    const pRef = widget.P();
    const page = pages.find((p) => p.ref === pRef) ?? pages.at(-1)!;
    return { page, x: r.x, y: r.y, width: r.width, height: r.height };
  }
  const page = pages.at(-1)!;
  return { page, x: 72, y: 60, width: 260, height: 36 };
}

export function createPdfEngine(pdfjs: PdfJsLike): DocumentEngine {
  return {
    async load(id: string, name: string, bytes: Uint8Array, source: DocumentSource): Promise<LoadedDocument> {
      const copy = bytes.slice();
      const pdf = await PDFDocument.load(copy, { ignoreEncryption: false });
      const fields = await readFields(pdf);
      const js = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      const pages: string[] = [];
      try {
        for (let n = 1; n <= js.numPages; n++)
          pages.push(textOf((await (await js.getPage(n)).getTextContent()).items));
      } finally {
        await js.destroy();
      }
      return {
        id,
        name,
        bytes: copy,
        sha256: sha256Hex(copy),
        pageCount: pdf.getPageCount(),
        pages,
        fields,
        source,
      };
    },

    async fill(bytes: Uint8Array, values: Record<string, string>): Promise<Uint8Array> {
      const pdf = await PDFDocument.load(bytes.slice());
      const form = pdf.getForm();
      for (const [name, value] of Object.entries(values)) {
        const field = form.getFieldMaybe(name);
        if (field instanceof PDFTextField) field.setText(winAnsi(value));
        else if (field instanceof PDFCheckBox) {
          if (value) field.check();
          else field.uncheck();
        }
      }
      return pdf.save();
    },

    async sign(bytes: Uint8Array, req: SignatureRequest): Promise<Uint8Array> {
      if (sha256Hex(bytes) !== req.documentSha256)
        throw new Error("The document changed after it was reviewed. Review it again before signing.");
      const pdf = await PDFDocument.load(bytes.slice());
      if (pdf.getPageCount() !== req.pageCount)
        throw new Error("The page count doesn't match what was reviewed.");
      const sigFont = await pdf.embedFont(
        req.style === "script"
          ? StandardFonts.TimesRomanItalic
          : req.style === "classic"
            ? StandardFonts.TimesRoman
            : StandardFonts.Helvetica,
      );
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const ink = rgb(0.07, 0.1, 0.15);

      // 1. The typed signature on the signature line (fields keep their values, not flattened).
      const spot = signatureSpot(pdf);
      const name = winAnsi(req.signerName);
      const size = Math.max(10, Math.min(22, spot.height * 0.7));
      spot.page.drawText(name, {
        x: spot.x + 4,
        y: spot.y + (spot.height - size) / 2 + 2,
        size,
        font: sigFont,
        color: rgb(0.05, 0.15, 0.45),
      });
      spot.page.drawText(winAnsi(`Signed electronically ${req.signedAt} - see certificate page`), {
        x: spot.x + 4,
        y: Math.max(8, spot.y - 10),
        size: 7,
        font,
        color: ink,
      });
      // Signature fields can't hold drawn text; mark text fields named like "signature" too.
      const sigField = pdf
        .getForm()
        .getFields()
        .find((f) => f instanceof PDFTextField && /sign/i.test(f.getName()));
      if (sigField instanceof PDFTextField) sigField.setText(`/s/ ${name}`);

      // 2. The audit certificate page.
      const page = pdf.addPage([612, 792]);
      let y = 720;
      const left = 64;
      const width = 612 - left * 2;
      const line = (text: string, opts: { size?: number; bold?: boolean; gap?: number } = {}) => {
        const s = opts.size ?? 11;
        for (const l of wrap(winAnsi(text), opts.bold ? bold : font, s, width)) {
          page.drawText(l, { x: left, y, size: s, font: opts.bold ? bold : font, color: ink });
          y -= s * 1.4;
        }
        y -= opts.gap ?? 6;
      };
      line(CERTIFICATE_TITLE, { size: 20, bold: true, gap: 12 });
      line("Document", { bold: true, gap: 0 });
      line(req.documentName);
      line("Signed by", { bold: true, gap: 0 });
      line(req.signerName);
      line("Time of signing", { bold: true, gap: 0 });
      line(req.signedAt);
      line("SHA-256 of the document as reviewed (before signing)", { bold: true, gap: 0 });
      line(req.documentSha256, { size: 9 });
      line("Pages reviewed", { bold: true, gap: 0 });
      line(`All ${req.pageCount} page${req.pageCount === 1 ? "" : "s"}`);
      line("How it was signed", { bold: true, gap: 0 });
      line(
        `${EYE_GAZE_LINE} The signer reviewed every page, adopted the typed signature shown, and confirmed twice: a long dwell, then a second confirmation in a different place on the screen.`,
      );
      line("Statement of intent", { bold: true, gap: 0 });
      line(`"${req.intent}"`);
      line("Note", { bold: true, gap: 0 });
      line(ESIGN_NOTE, { size: 9 });

      pdf.setProducer("AGENCY task pack: documents");
      pdf.setModificationDate(new Date(req.signedAt));
      pdf.catalog.set(PDFName.of("AGENCYSigned"), PDFName.of("EyeGazeConfirmation"));
      return pdf.save();
    },

    async renderPage(bytes: Uint8Array, pageIndex: number, width: number): Promise<string> {
      const js = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      try {
        const page = await js.getPage(pageIndex + 1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("No canvas");
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        return canvas.toDataURL("image/png");
      } finally {
        await js.destroy();
      }
    },
  };
}
