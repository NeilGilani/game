/**
 * Papers' file access, kept in main and as narrow as it can be: list one folder (the one a helper chose), read one
 * document from it, and save a new copy next to it. The shell only ever names a file inside that folder; everything
 * here checks it again: a plain name (no folders, no ".."), a PDF/PNG/JPEG by extension and by its first bytes, the
 * real file (symlinks resolved) still inside the folder, and a size limit. A save never overwrites anything.
 */

import { constants, promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { PaperFile } from "@agency/contracts";

/** Bigger files are left out of the list and refused (a letter or form is far smaller). */
export const MAX_PAPER_BYTES = 30 * 1024 * 1024;
/** The newest this many documents are listed. */
export const MAX_LISTED = 100;
export const PAPER_EXTENSIONS: Record<string, PaperFile["kind"]> = {
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
};

/** A refusal with a sentence the shell can show. */
export class PapersError extends Error {}

/** Is this a plain file name AGENCY may touch (no path, no hidden file, an allowed extension)? */
export function validName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
  if (name !== basename(name) || /[/\\\0]/.test(name) || name === "." || name === "..") return false;
  if (name.startsWith(".") || name.includes("..")) return false;
  return extname(name).toLowerCase() in PAPER_EXTENSIONS;
}

function magicOk(kind: string, b: Uint8Array): boolean {
  if (kind === ".pdf") return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
  if (kind === ".png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; // JPEG
}

/** Is this folder one Papers may use? Never the disk's root or the whole home folder. */
export async function validFolder(folder: string, home: string): Promise<boolean> {
  if (!isAbsolute(folder)) return false;
  try {
    const real = await fs.realpath(folder);
    const realHome = await fs.realpath(home).catch(() => resolve(home));
    if (real === resolve("/") || real === realHome) return false;
    return (await fs.stat(real)).isDirectory();
  } catch {
    return false;
  }
}

/** The real path of `name` inside `folder`, or a refusal. Symlinks that lead outside the folder are refused. */
export async function resolveInside(folder: string, name: string): Promise<string> {
  if (!validName(name))
    throw new PapersError("AGENCY can only open PDF, PNG or JPEG files in the Papers folder.");
  let realFolder: string;
  try {
    realFolder = await fs.realpath(folder);
  } catch {
    throw new PapersError(
      "The Papers folder isn't there any more. A helper can choose it again in Settings.",
    );
  }
  let real: string;
  try {
    real = await fs.realpath(join(realFolder, name));
  } catch {
    throw new PapersError(`"${name}" isn't in the Papers folder any more.`);
  }
  if (!real.startsWith(realFolder + sep) || real.slice(realFolder.length + 1).includes(sep))
    throw new PapersError(`"${name}" is outside the Papers folder, so AGENCY won't open it.`);
  const st = await fs.stat(real);
  if (!st.isFile()) throw new PapersError(`"${name}" isn't a document.`);
  if (st.size > MAX_PAPER_BYTES)
    throw new PapersError(`"${name}" is too big for AGENCY to open (over 30 MB).`);
  return real;
}

/** The folder's documents, newest first. Anything unsafe or unsuitable is simply left out. */
export async function listPapers(folder: string): Promise<PaperFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(folder);
  } catch {
    throw new PapersError("AGENCY can't open the Papers folder. A helper can choose it again in Settings.");
  }
  const out: PaperFile[] = [];
  for (const name of entries) {
    if (!validName(name)) continue;
    try {
      const real = await resolveInside(folder, name);
      const st = await fs.stat(real);
      out.push({
        name,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        kind: PAPER_EXTENSIONS[extname(name).toLowerCase()]!,
      });
    } catch {
      /* not listed */
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  return out.slice(0, MAX_LISTED);
}

/** One document's bytes, after every check. */
export async function readPaper(folder: string, name: string): Promise<Uint8Array> {
  const real = await resolveInside(folder, name);
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_PAPER_BYTES)
      throw new PapersError(`"${name}" is too big for AGENCY to open.`);
    const bytes = new Uint8Array(await handle.readFile());
    if (!magicOk(extname(name).toLowerCase(), bytes))
      throw new PapersError(`"${name}" isn't really a ${extname(name).slice(1).toUpperCase()} file.`);
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Save `bytes` as a new PDF next to `original`: "Form-filled.pdf", or "Form-filled-2.pdf" when that name is taken.
 * Never overwrites (the file is created exclusively), never writes anything that isn't a PDF.
 */
export async function saveCopy(
  folder: string,
  original: string,
  suffix: unknown,
  bytes: unknown,
): Promise<{ name: string }> {
  if (suffix !== "filled" && suffix !== "signed") throw new PapersError("Unknown kind of copy.");
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PAPER_BYTES)
    throw new PapersError("The new copy is empty or too big.");
  if (!magicOk(".pdf", bytes)) throw new PapersError("AGENCY only saves PDF copies.");
  if (extname(original).toLowerCase() !== ".pdf")
    throw new PapersError("Only a PDF can be filled in or signed.");
  await resolveInside(folder, original);
  const realFolder = await fs.realpath(folder);
  const stem = original.slice(0, -extname(original).length);
  for (let n = 1; n <= 99; n++) {
    const name = `${stem}-${suffix}${n === 1 ? "" : `-${n}`}.pdf`;
    if (!validName(name)) throw new PapersError("That name is too long to save next to the original.");
    try {
      // "wx": create a new file, or fail if anything (a file, a symlink) already has this name.
      await fs.writeFile(join(realFolder, name), bytes, { flag: "wx" });
      return { name };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new PapersError("There are already too many copies of this document.");
}

/** "/Users/riley/Documents/AGENCY Papers" -> "~/Documents/AGENCY Papers". */
export function displayFolder(folder: string, home: string): string {
  return folder === home || folder.startsWith(home + sep) ? `~${folder.slice(home.length)}` : folder;
}
