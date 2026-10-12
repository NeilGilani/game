import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PAPER_BYTES,
  PapersError,
  displayFolder,
  listPapers,
  readPaper,
  resolveInside,
  saveCopy,
  validFolder,
  validName,
} from "../src/main/papers";

const PDF = new TextEncoder().encode("%PDF-1.7\n% a tiny test file\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let root: string;
let folder: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agency-papers-"));
  folder = join(root, "AGENCY Papers");
  outside = join(root, "private");
  mkdirSync(folder);
  mkdirSync(outside);
  writeFileSync(join(folder, "Letter.pdf"), PDF);
  writeFileSync(join(folder, "Scan.png"), PNG);
  writeFileSync(join(folder, "notes.txt"), "not a document");
  writeFileSync(join(folder, ".hidden.pdf"), PDF);
  writeFileSync(join(outside, "Taxes.pdf"), PDF);
  utimesSync(join(folder, "Letter.pdf"), new Date("2026-10-01"), new Date("2026-10-01"));
  utimesSync(join(folder, "Scan.png"), new Date("2026-10-10"), new Date("2026-10-10"));
});

describe("Papers path guard", () => {
  it("only plain document names are allowed", () => {
    expect(validName("Letter.pdf")).toBe(true);
    expect(validName("Photo.JPG")).toBe(true);
    for (const bad of [
      "../private/Taxes.pdf",
      "..",
      "a/b.pdf",
      "a\\b.pdf",
      "/etc/passwd",
      ".hidden.pdf",
      "notes.txt",
      "evil.pdf\0.png",
      "x".repeat(300) + ".pdf",
      42,
      null,
    ])
      expect(validName(bad)).toBe(false);
  });

  it("lists only documents in the folder, newest first", async () => {
    symlinkSync(join(outside, "Taxes.pdf"), join(folder, "Taxes.pdf"));
    const list = await listPapers(folder);
    expect(list.map((f) => [f.name, f.kind])).toEqual([
      ["Scan.png", "image"],
      ["Letter.pdf", "pdf"],
    ]);
  });

  it("refuses traversal and symlinks that lead out of the folder", async () => {
    await expect(resolveInside(folder, "../private/Taxes.pdf")).rejects.toBeInstanceOf(PapersError);
    symlinkSync(join(outside, "Taxes.pdf"), join(folder, "Taxes.pdf"));
    await expect(readPaper(folder, "Taxes.pdf")).rejects.toThrow(/outside the Papers folder/);
    symlinkSync(outside, join(folder, "Sub.pdf")); // a folder in disguise
    await expect(readPaper(folder, "Sub.pdf")).rejects.toThrow();
    // A symlink that stays inside the folder is fine.
    symlinkSync(join(folder, "Letter.pdf"), join(folder, "Same letter.pdf"));
    expect(await readPaper(folder, "Same letter.pdf")).toEqual(PDF);
  });

  it("refuses huge files and files that aren't what their name says", async () => {
    const big = join(folder, "Huge.pdf");
    writeFileSync(big, PDF);
    truncateSync(big, MAX_PAPER_BYTES + 1);
    await expect(readPaper(folder, "Huge.pdf")).rejects.toThrow(/too big/);
    expect((await listPapers(folder)).map((f) => f.name)).not.toContain("Huge.pdf");
    writeFileSync(join(folder, "Fake.pdf"), "MZ not a pdf");
    await expect(readPaper(folder, "Fake.pdf")).rejects.toThrow(/isn't really a PDF/);
    expect(await readPaper(folder, "Letter.pdf")).toEqual(PDF);
  });

  it("saves a new copy next to the original and never overwrites", async () => {
    expect(await saveCopy(folder, "Letter.pdf", "filled", PDF)).toEqual({ name: "Letter-filled.pdf" });
    expect(await saveCopy(folder, "Letter.pdf", "filled", PDF)).toEqual({ name: "Letter-filled-2.pdf" });
    // A symlink squatting on the next name is not followed or replaced.
    symlinkSync(join(outside, "Taxes.pdf"), join(folder, "Letter-signed.pdf"));
    expect(await saveCopy(folder, "Letter.pdf", "signed", PDF)).toEqual({ name: "Letter-signed-2.pdf" });
    expect(readFileSync(join(outside, "Taxes.pdf"))).toEqual(Buffer.from(PDF));
    expect(readFileSync(join(folder, "Letter.pdf"))).toEqual(Buffer.from(PDF));
  });

  it("refuses to save anything but a PDF copy of a document in the folder", async () => {
    await expect(saveCopy(folder, "Letter.pdf", "filled", PNG)).rejects.toThrow(/only saves PDF/);
    await expect(saveCopy(folder, "Letter.pdf", "../x", PDF)).rejects.toThrow(/Unknown kind/);
    await expect(saveCopy(folder, "Letter.pdf", "filled", "not bytes")).rejects.toThrow(/empty or too big/);
    await expect(saveCopy(folder, "Scan.png", "signed", PDF)).rejects.toThrow(/Only a PDF/);
    await expect(saveCopy(folder, "../private/Taxes.pdf", "signed", PDF)).rejects.toBeInstanceOf(PapersError);
    await expect(
      saveCopy(folder, "Letter.pdf", "filled", new Uint8Array(MAX_PAPER_BYTES + 1).fill(0x25)),
    ).rejects.toThrow(/too big/);
  });

  it("the folder must be a real folder, not the disk or the whole home folder", async () => {
    expect(await validFolder(folder, root)).toBe(true);
    expect(await validFolder(root, root)).toBe(false);
    expect(await validFolder("/", root)).toBe(false);
    expect(await validFolder("relative/folder", root)).toBe(false);
    expect(await validFolder(join(folder, "Letter.pdf"), root)).toBe(false);
    expect(await validFolder(join(root, "missing"), root)).toBe(false);
    expect(displayFolder(folder, root)).toBe("~/AGENCY Papers");
  });
});
