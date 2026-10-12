/**
 * Papers on the person's own PDFs: read the text of each page (pdf.js), read and fill the
 * form's fields (pdf-lib), find places a signature could go, put one signature in the one
 * place the person approved, and check the saved result by reading it back.
 *
 * Nothing here writes a file; the caller saves the returned bytes as a new copy.
 */

import {
  PDFCheckBox,
  PDFDocument,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFString,
  PDFTextField,
  StandardFonts,
  rgb,
  type PDFField,
} from "pdf-lib";
import { sha256Hex } from "../../core/sha256";
import { humanize, type PaperField } from "../fields";
import { winAnsi, type PdfJsLike } from "./index";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignatureSpot {
  id: string;
  /** Plain words for the card: "The signature box on the form". */
  label: string;
  rect: Rect;
  kind: "field" | "label" | "corner";
}

/** Thrown with a sentence the screen can show as it is. */
export class PaperError extends Error {}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes.slice());
  } catch (err) {
    if (/encrypt/i.test(String((err as Error)?.message)))
      throw new PaperError("This PDF is locked with a password, so AGENCY can't change it.");
    throw new PaperError("AGENCY couldn't open this file. It may be damaged or not a PDF.");
  }
}

/** The text of every page, in order. Untrusted: shown and read aloud, never followed. */
export async function pageTexts(pdfjs: PdfJsLike, bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const { items } = await (await doc.getPage(n)).getTextContent();
      let text = "";
      for (const item of items) {
        const i = item as { str?: string; hasEOL?: boolean };
        if (typeof i.str !== "string") continue;
        text += i.str + (i.hasEOL ? "\n" : " ");
      }
      out.push(
        text
          .replace(/[ \t]+\n/g, "\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim(),
      );
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

function tooltip(f: PDFField): string {
  const tu = f.acroField.dict.lookup(PDFName.of("TU"));
  if (tu instanceof PDFString || tu instanceof PDFHexString) return tu.decodeText().trim();
  return "";
}

/** The form's fields, in the form's order, with what each one holds now. */
export async function readForm(bytes: Uint8Array): Promise<PaperField[]> {
  const pdf = await loadPdf(bytes);
  const pages = pdf.getPages();
  return pdf
    .getForm()
    .getFields()
    .map((f): PaperField => {
      const widget = f.acroField.getWidgets()[0];
      const pRef = widget?.P();
      const page = pRef ? pages.findIndex((p) => p.ref === pRef) : -1;
      const base = {
        name: f.getName(),
        label: (tooltip(f) || humanize(f.getName())).slice(0, 120),
        ...(page >= 0 ? { page } : {}),
        ...(f.isReadOnly() ? { readOnly: true } : {}),
      };
      if (f instanceof PDFTextField) {
        const max = f.getMaxLength();
        return {
          ...base,
          type: "text",
          value: f.getText() ?? "",
          ...(max ? { maxLength: max } : {}),
          ...(f.isMultiline() ? { multiline: true } : {}),
        };
      }
      if (f instanceof PDFCheckBox) return { ...base, type: "checkbox", value: f.isChecked() ? "yes" : "" };
      if (f instanceof PDFDropdown || f instanceof PDFOptionList)
        return { ...base, type: "choice", value: f.getSelected()[0] ?? "", options: f.getOptions() };
      if (f instanceof PDFRadioGroup)
        return { ...base, type: "choice", value: f.getSelected() ?? "", options: f.getOptions() };
      return { ...base, type: "signature", value: "" };
    });
}

/** Characters the form's standard font can't draw are replaced; the review shows the result. */
export function fillableText(value: string): string {
  return winAnsi(value).replace(/\n/g, " ");
}

/** Fill the named fields with exactly these values. Other fields are left as they are. */
export async function fillForm(bytes: Uint8Array, values: Record<string, string>): Promise<Uint8Array> {
  const pdf = await loadPdf(bytes);
  const form = pdf.getForm();
  for (const [name, value] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f) throw new PaperError(`The form has no field called "${name}".`);
    if (f.isReadOnly()) throw new PaperError(`"${name}" can't be changed on this form.`);
    if (f instanceof PDFTextField) {
      const text = f.isMultiline() ? winAnsi(value) : fillableText(value);
      f.setText(text || undefined);
    } else if (f instanceof PDFCheckBox) {
      if (value) f.check();
      else f.uncheck();
    } else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) {
      // Only the form's own choices: a dropdown would otherwise take any text.
      if (value && !f.getOptions().includes(value))
        throw new PaperError(`"${value}" isn't one of the choices for "${name}".`);
      if (value) f.select(value);
      else f.clear();
    } else throw new PaperError(`AGENCY doesn't fill "${name}" (a signature field).`);
  }
  return pdf.save();
}

/** What each field holds, read back from saved bytes (for checking a filled copy). */
export async function readValues(bytes: Uint8Array): Promise<Record<string, string>> {
  const fields = await readForm(bytes);
  return Object.fromEntries(fields.map((f) => [f.name, f.value]));
}

/** Did every value land? Returns the names that didn't. */
export async function checkFilled(bytes: Uint8Array, values: Record<string, string>): Promise<string[]> {
  const got = await readValues(bytes);
  return Object.entries(values)
    .filter(([name, v]) => {
      const expected = /\n/.test(v) ? winAnsi(v) : fillableText(v);
      return (got[name] ?? "") !== expected;
    })
    .map(([name]) => name);
}

export async function pageSizes(bytes: Uint8Array): Promise<{ width: number; height: number }[]> {
  const pdf = await loadPdf(bytes);
  return pdf.getPages().map((p) => p.getSize());
}

const SPOT_W = 220;
const SPOT_H = 44;
const MARGIN = 36;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

function clampRect(r: Rect, page: { width: number; height: number }): Rect {
  const width = Math.max(40, Math.min(r.width, page.width - 2 * 8));
  const height = Math.max(16, Math.min(r.height, page.height - 2 * 8));
  return {
    x: Math.max(8, Math.min(r.x, page.width - width - 8)),
    y: Math.max(8, Math.min(r.y, page.height - height - 8)),
    width,
    height,
  };
}

const SIGN_LABEL = /\b(signature|sign here|signed|sign)\b/i;

/**
 * Up to four places a signature could go on this page: signature boxes on the form first,
 * then next to words like "Signature", then the bottom corners. The person picks one.
 */
export async function signatureSpots(
  pdfjs: PdfJsLike,
  bytes: Uint8Array,
  pageIndex: number,
): Promise<SignatureSpot[]> {
  const pdf = await loadPdf(bytes);
  const page = pdf.getPages()[pageIndex];
  if (!page) throw new PaperError("That page isn't in this document.");
  const size = page.getSize();
  const spots: SignatureSpot[] = [];
  const add = (s: SignatureSpot) => {
    const rect = clampRect(s.rect, size);
    if (spots.length < 4 && !spots.some((o) => overlap(o.rect, rect) > 0.5)) spots.push({ ...s, rect });
  };

  for (const f of pdf.getForm().getFields()) {
    const isSig = f instanceof PDFSignature || (f instanceof PDFTextField && /sign/i.test(f.getName()));
    if (!isSig) continue;
    for (const w of f.acroField.getWidgets()) {
      if (w.P() !== page.ref) continue;
      const r = w.getRectangle();
      add({ id: `field-${spots.length}`, label: "The signature box on the form", rect: r, kind: "field" });
    }
  }

  const js = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    const items = (await (await js.getPage(pageIndex + 1)).getTextContent()).items as {
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
    }[];
    for (const it of items) {
      const str = (it.str ?? "").trim();
      if (!str || str.length > 60 || !SIGN_LABEL.test(str) || !it.transform) continue;
      const x = it.transform[4] ?? 0;
      const y = it.transform[5] ?? 0;
      const w = it.width ?? 0;
      const h = it.height || Math.abs(it.transform[3] ?? 10);
      const blank = str.indexOf("_");
      const words = str
        .replace(/_+/g, "")
        .replace(/[:\s]+$/, "")
        .trim()
        .slice(0, 30);
      // "Signature: ______": over the line. "Signature" alone: to its right, or above it near the edge.
      const labelEnd = blank > 0 ? x + (w * blank) / str.length : x + w;
      const right = labelEnd + 6 + SPOT_W <= size.width - MARGIN / 2;
      const rect = right
        ? { x: labelEnd + 6, y: y - 6, width: SPOT_W, height: SPOT_H }
        : { x, y: y + h + 4, width: SPOT_W, height: SPOT_H };
      add({ id: `label-${spots.length}`, label: `Next to "${words}"`, rect, kind: "label" });
    }
  } finally {
    await js.destroy();
  }

  add({
    id: "corner-left",
    label: "Bottom of the page, on the left",
    rect: { x: 72, y: 72, width: SPOT_W, height: SPOT_H },
    kind: "corner",
  });
  add({
    id: "corner-right",
    label: "Bottom of the page, on the right",
    rect: { x: size.width - 72 - SPOT_W, y: 72, width: SPOT_W, height: SPOT_H },
    kind: "corner",
  });
  return spots;
}

export interface StampRequest {
  pageIndex: number;
  rect: Rect;
  /** A signature picture (PNG or JPEG): the saved one, or a picture of the typed name. */
  image?: Uint8Array;
  /** Set for the typed-name fallback: labelled as typed, and drawn in a slanted font when there's no picture of it. */
  typedName?: string;
  signerName: string;
  /** ISO time of the final confirmation. */
  signedAt: string;
  /** SHA-256 of the exact bytes the person reviewed. */
  documentSha256: string;
}

/** The small line printed under every signature AGENCY puts on a page. */
export function stampLine(req: Pick<StampRequest, "signerName" | "signedAt" | "typedName">): string {
  const day = req.signedAt.slice(0, 10);
  return winAnsi(
    `Signed electronically${req.signerName.trim() ? ` by ${req.signerName.trim()}` : ""} on ${day} with AGENCY (eye-gaze confirmation).${req.typedName ? " Typed signature." : ""}`,
  );
}

function isPng(b: Uint8Array): boolean {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}
function isJpeg(b: Uint8Array): boolean {
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** Put one signature in one place. Refuses if the document isn't the one that was reviewed. */
export async function stampSignature(bytes: Uint8Array, req: StampRequest): Promise<Uint8Array> {
  if (sha256Hex(bytes) !== req.documentSha256)
    throw new PaperError("The document changed after you reviewed it, so AGENCY didn't sign it.");
  if (!req.image && !req.typedName?.trim())
    throw new PaperError("Choose a signature first: your saved one or your typed name.");
  const pdf = await loadPdf(bytes);
  const page = pdf.getPages()[req.pageIndex];
  if (!page) throw new PaperError("That page isn't in this document.");
  const size = page.getSize();
  const r = req.rect;
  if (
    r.width <= 0 ||
    r.height <= 0 ||
    r.x < 0 ||
    r.y < 0 ||
    r.x + r.width > size.width ||
    r.y + r.height > size.height
  )
    throw new PaperError("That place isn't on the page.");

  if (req.image) {
    const img = isPng(req.image)
      ? await pdf.embedPng(req.image)
      : isJpeg(req.image)
        ? await pdf.embedJpg(req.image)
        : null;
    if (!img) throw new PaperError("The saved signature isn't a PNG or JPEG picture.");
    const scale = Math.min(r.width / img.width, r.height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: r.x, y: r.y + (r.height - h) / 2, width: w, height: h });
  } else {
    const font = await pdf.embedFont(StandardFonts.TimesRomanItalic);
    const name = winAnsi(req.typedName!.trim());
    let fontSize = Math.min(26, r.height * 0.7);
    while (fontSize > 8 && font.widthOfTextAtSize(name, fontSize) > r.width - 8) fontSize -= 1;
    page.drawText(name, {
      x: r.x + 4,
      y: r.y + (r.height - fontSize) / 2 + 2,
      size: fontSize,
      font,
      color: rgb(0.05, 0.15, 0.45),
    });
  }
  const small = await pdf.embedFont(StandardFonts.Helvetica);
  const line = stampLine(req);
  let lineSize = 6.5;
  while (lineSize > 4 && small.widthOfTextAtSize(line, lineSize) > size.width - r.x - 8) lineSize -= 0.5;
  page.drawText(line, {
    x: r.x,
    y: r.y >= 12 ? r.y - 8 : r.y + r.height + 3,
    size: lineSize,
    font: small,
    color: rgb(0.2, 0.2, 0.25),
  });
  pdf.setModificationDate(new Date(req.signedAt));
  return pdf.save();
}

function imageCount(pdf: PDFDocument, pageIndex: number): number {
  const res = pdf.getPages()[pageIndex]?.node.Resources();
  const xo = res?.lookup(PDFName.of("XObject"));
  return xo instanceof PDFDict ? xo.keys().length : 0;
}

/**
 * Read a signed copy back: same pages, the signature line on the approved page exactly once,
 * every other page's text unchanged, and (for a picture) one more image on that page.
 */
export async function checkSigned(
  pdfjs: PdfJsLike,
  before: Uint8Array,
  after: Uint8Array,
  req: StampRequest,
): Promise<{ ok: boolean; problem?: string }> {
  const [a, b] = [await pageTexts(pdfjs, before), await pageTexts(pdfjs, after)];
  if (a.length !== b.length) return { ok: false, problem: "The page count changed." };
  const line = stampLine(req).replace(/\s+/g, "");
  for (let i = 0; i < b.length; i++) {
    const count = b[i]!.replace(/\s+/g, "").split(line).length - 1;
    if (i === req.pageIndex) {
      const was = a[i]!.replace(/\s+/g, "").split(line).length - 1;
      if (count !== was + 1)
        return { ok: false, problem: "The signature line isn't on the chosen page once." };
    } else if (b[i] !== a[i]) return { ok: false, problem: `Page ${i + 1} changed, and it shouldn't have.` };
  }
  if (req.image) {
    const [pa, pb] = [await loadPdf(before), await loadPdf(after)];
    if (imageCount(pb, req.pageIndex) !== imageCount(pa, req.pageIndex) + 1)
      return { ok: false, problem: "The signature picture isn't on the page." };
  } else if (
    !b[req.pageIndex]!.replace(/\s+/g, "").includes(winAnsi(req.typedName!.trim()).replace(/\s+/g, ""))
  )
    return { ok: false, problem: "The typed signature isn't on the page." };
  return { ok: true };
}
