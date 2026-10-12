/** pdf.js in the page (with its worker), for pictures of pages, and the typed-name signature picture. */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfJsLike } from "../../../os/tasks/src/documents/pdf/index";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const pdfjsLib = pdfjs as unknown as PdfJsLike;

export interface PagePicture {
  url: string;
  /** The page's size in PDF points, to place boxes over the picture. */
  width: number;
  height: number;
}

/** One page as a PNG data URL, `px` wide. */
export async function renderPage(bytes: Uint8Array, pageIndex: number, px: number): Promise<PagePicture> {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: px / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return { url: canvas.toDataURL("image/png"), width: base.width, height: base.height };
  } finally {
    await doc.destroy();
  }
}

export function imageUrl(bytes: Uint8Array, name: string): string {
  const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
}

/** Handwriting-like fonts found on Macs and PCs; the generic cursive font last. */
const SCRIPT_FONTS = '"Snell Roundhand", "Apple Chancery", "Brush Script MT", "Segoe Script", cursive';

/** The typed name drawn in a script font, as a PNG. Null when the page can't draw (then a slanted font is used). */
export async function typedSignaturePng(name: string): Promise<Uint8Array | null> {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const size = 96;
    ctx.font = `${size}px ${SCRIPT_FONTS}`;
    const w = Math.ceil(ctx.measureText(name).width) + 40;
    canvas.width = Math.min(2000, w);
    canvas.height = Math.round(size * 1.5);
    ctx.font = `${size}px ${SCRIPT_FONTS}`;
    ctx.fillStyle = "#0d2673";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 20, canvas.height / 2);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
