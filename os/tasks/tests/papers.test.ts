import { crc32, deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/sha256";
import {
  basicExplanation,
  explanationSpeech,
  factHolds,
  hasReadableText,
  letterText,
  quoteAppears,
  validateExplanation,
} from "../src/documents/explain";
import { copyName, formSteps, humanize, validAnswer } from "../src/documents/fields";
import type { PdfJsLike } from "../src/documents/pdf/index";
import {
  PaperError,
  checkFilled,
  checkSigned,
  fillForm,
  pageTexts,
  readForm,
  readValues,
  signatureSpots,
  stampLine,
  stampSignature,
} from "../src/documents/pdf/papers";
import { benefitsRenewalPdf } from "../src/documents/pdf/samples";
import { DEMO_PROFILE } from "../src/profile";

const js = pdfjs as unknown as PdfJsLike;

/** A real PNG (w x h, solid dark blue), built by hand so no binary fixture is checked in. */
function png(w = 40, h = 12): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) rows.set([10, 30, 110], y * (w * 3 + 1) + 1 + x * 3);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** A form with every kind of field AGENCY fills, and a "Signature:" line with no box. */
async function mixedForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  const form = pdf.getForm();
  page.drawText("Housing application", { x: 64, y: 740, size: 16, font });
  form.createTextField("applicant.first_name").addToPage(page, { x: 64, y: 680, width: 200, height: 20 });
  form.createTextField("ssn").addToPage(page, { x: 64, y: 640, width: 200, height: 20 });
  form.createCheckBox("has_pets").addToPage(page, { x: 64, y: 600, width: 14, height: 14 });
  const dd = form.createDropdown("county");
  dd.addOptions(["Lane", "Linn", "Benton"]);
  dd.addToPage(page, { x: 64, y: 560, width: 120, height: 20 });
  form.createTextField("date").addToPage(page, { x: 64, y: 520, width: 120, height: 20 });
  page.drawText("Signature: ____________________", { x: 64, y: 200, size: 11, font });
  pdf.addPage([612, 792]).drawText("Page two stays as it is.", { x: 64, y: 700, size: 11, font });
  return pdf.save();
}

const LETTER = [
  "Springfield Benefits Office",
  "Dear Riley Morgan,",
  "Your current monthly amount is $1,240.00. It will continue if you renew",
  "by November 30, 2026. If we don't receive this form, payments may stop.",
].join("\n");

describe("explaining a letter", () => {
  it("keeps facts whose quote is in the letter and drops made-up ones", () => {
    const e = validateExplanation(
      {
        what: "A renewal letter for your disability benefit.",
        from: "Springfield Benefits Office",
        from_quote: "Springfield Benefits Office",
        wants: "Renew by sending the form back.",
        deadlines: [
          { text: "Renew by November 30, 2026", quote: "by November 30, 2026." },
          { text: "Call by December 5, 2026", quote: "Call us by December 5, 2026" }, // not in the letter
          { text: "Renew by November 31, 2026", quote: "by November 30, 2026" }, // number not in the quote
        ],
        amounts: [
          { text: "$1,240.00 a month", quote: "Your current monthly amount is $1,240.00." },
          { text: "$2,000 bonus", quote: "Your current monthly amount" }, // quote real, number invented
        ],
        next_steps: ["Check your details", "Sign and send the form", "", "a", "b", "c"],
      },
      LETTER,
    )!;
    expect(e.source).toBe("gemini");
    expect(e.deadlines).toEqual([{ text: "Renew by November 30, 2026", quote: "by November 30, 2026." }]);
    expect(e.amounts.map((a) => a.text)).toEqual(["$1,240.00 a month"]);
    expect(e.dropped).toBe(3);
    expect(e.fromQuote).toBe("Springfield Benefits Office");
    expect(e.nextSteps).toHaveLength(4);
    expect(explanationSpeech(e)).toMatch(/^A renewal letter.*November 30, 2026/);
  });

  it("matches quotes ignoring case, spacing and curly quotes, but not tiny ones", () => {
    expect(quoteAppears("YOUR  current\nmonthly amount", LETTER)).toBe(true);
    expect(quoteAppears("don’t receive", LETTER)).toBe(true);
    expect(quoteAppears("by", LETTER)).toBe(false);
    expect(factHolds({ text: "1,240.00", quote: "amount is $1,240.00" }, LETTER)).toBe(true);
  });

  it("rejects answers with nothing usable", () => {
    expect(validateExplanation(null, LETTER)).toBeNull();
    expect(validateExplanation({ deadlines: [] }, LETTER)).toBeNull();
  });

  it("the basic version finds dates and amounts with their lines, without AI", () => {
    const b = basicExplanation(LETTER);
    expect(b.source).toBe("basic");
    expect(b.deadlines).toEqual([
      {
        text: "Possible deadline: November 30, 2026",
        quote: "by November 30, 2026. If we don't receive this form, payments may stop.",
      },
    ]);
    expect(b.amounts[0]).toMatchObject({ text: "Amount: $1,240.00" });
    for (const f of [...b.deadlines, ...b.amounts]) expect(factHolds(f, LETTER)).toBe(true);
  });

  it("sends only bounded text with card numbers removed, and knows a scan has none", () => {
    const { text, truncated } = letterText(["Card 4111 1111 1111 1111 on file.", "x".repeat(20000)]);
    expect(text).not.toMatch(/4111/);
    expect(text.length).toBe(12000);
    expect(truncated).toBe(true);
    expect(hasReadableText("")).toBe(false);
    expect(hasReadableText(LETTER)).toBe(true);
  });
});

describe("filling a form", () => {
  it("reads every kind of field and offers only saved details", async () => {
    const fields = await readForm(await mixedForm());
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ["applicant.first_name", "text"],
      ["ssn", "text"],
      ["has_pets", "checkbox"],
      ["county", "choice"],
      ["date", "text"],
    ]);
    expect(fields[3]!.options).toEqual(["Lane", "Linn", "Benton"]);
    expect(humanize("applicant.first_name")).toBe("First name");

    const now = new Date("2026-10-12T12:00:00Z");
    const steps = formSteps(fields, DEMO_PROFILE, now);
    expect(steps[0]!.suggestions).toEqual([{ value: "Riley", from: "Your saved first name" }]);
    expect(steps[1]!.secret).toBe(true); // never filled by AGENCY
    expect(steps[1]!.suggestions).toEqual([]);
    expect(steps[4]!.suggestions).toEqual([{ value: "October 12, 2026", from: "Today's date" }]);

    // With no saved details there is nothing personal to suggest: the step asks.
    expect(formSteps(fields, null, now)[0]!.suggestions).toEqual([]);
    expect(validAnswer(fields[3]!, "Linn")).toBe(true);
    expect(validAnswer(fields[3]!, "Made up")).toBe(false);
  });

  it("fills exactly the chosen values and the saved copy reads back", async () => {
    const original = await mixedForm();
    const values = {
      "applicant.first_name": "Riley",
      has_pets: "yes",
      county: "Linn",
      date: "October 12, 2026",
    };
    const filled = await fillForm(original, values);
    expect(await checkFilled(filled, values)).toEqual([]);
    const got = await readValues(filled);
    expect(got).toMatchObject(values);
    expect(got.ssn).toBe("");
    // The original bytes are untouched.
    expect((await readValues(original))["applicant.first_name"]).toBe("");
    const reopened = await PDFDocument.load(filled);
    expect(reopened.getPageCount()).toBe(2);
  });

  it("refuses unknown fields and choices that aren't on the form", async () => {
    const original = await mixedForm();
    await expect(fillForm(original, { nope: "x" })).rejects.toBeInstanceOf(PaperError);
    await expect(fillForm(original, { county: "Atlantis" })).rejects.toThrow();
  });

  it("fills the benefits sample from the profile", async () => {
    const bytes = await benefitsRenewalPdf();
    const steps = formSteps(await readForm(bytes), DEMO_PROFILE);
    const values = Object.fromEntries(
      steps.filter((s) => s.suggestions[0]).map((s) => [s.field.name, s.suggestions[0]!.value]),
    );
    expect(Object.keys(values)).toEqual(["full_name", "date_of_birth", "address", "phone", "email"]);
    expect(await checkFilled(await fillForm(bytes, values), values)).toEqual([]);
    expect(copyName("Benefits renewal.pdf", "filled")).toBe("Benefits renewal-filled.pdf");
  });
});

describe("signing in one place", () => {
  it("finds the signature box, the Signature label and the corners", async () => {
    const benefits = await benefitsRenewalPdf();
    const spots = await signatureSpots(js, benefits, 1);
    expect(spots[0]).toMatchObject({ kind: "field", label: "The signature box on the form" });
    expect(spots.map((s) => s.kind)).toContain("corner");
    expect(spots.length).toBeLessThanOrEqual(4);

    const mixed = await signatureSpots(js, await mixedForm(), 0);
    const label = mixed.find((s) => s.kind === "label")!;
    expect(label.label).toBe('Next to "Signature"');
    expect(label.rect.y).toBeGreaterThan(180);
    expect(label.rect.y).toBeLessThan(200);
  });

  it("puts a saved signature picture in the chosen place, and nowhere else", async () => {
    const original = await mixedForm();
    const [spot] = (await signatureSpots(js, original, 0)).filter((s) => s.kind === "label");
    const req = {
      pageIndex: 0,
      rect: spot!.rect,
      image: png(),
      signerName: "Riley Morgan",
      signedAt: "2026-10-12T15:00:00.000Z",
      documentSha256: sha256Hex(original),
    };
    const signed = await stampSignature(original, req);
    expect(await checkSigned(js, original, signed, req)).toEqual({ ok: true });
    const texts = await pageTexts(js, signed);
    expect(texts[0]).toContain("Signed electronically by Riley Morgan on 2026-10-12");
    expect(texts[1]).toBe("Page two stays as it is.");
    const reopened = await PDFDocument.load(signed);
    expect(reopened.getPageCount()).toBe(2);
    // Signing twice in the same place is caught by the read-back (it counts the lines).
    const twice = await stampSignature(signed, { ...req, documentSha256: sha256Hex(signed) });
    expect((await checkSigned(js, original, twice, req)).ok).toBe(false);
  });

  it("the typed-name fallback is drawn and labelled as typed", async () => {
    const original = await benefitsRenewalPdf();
    const [spot] = await signatureSpots(js, original, 1);
    const req = {
      pageIndex: 1,
      rect: spot!.rect,
      typedName: "Riley Morgan",
      signerName: "Riley Morgan",
      signedAt: "2026-10-12T15:00:00.000Z",
      documentSha256: sha256Hex(original),
    };
    expect(stampLine(req)).toMatch(/Typed signature\.$/);
    const signed = await stampSignature(original, req);
    expect(await checkSigned(js, original, signed, req)).toEqual({ ok: true });
    expect((await pageTexts(js, signed))[1]).toContain("Typed signature.");
  });

  it("refuses a changed document, two signatures at once, or a place off the page", async () => {
    const original = await mixedForm();
    const base = {
      pageIndex: 0,
      rect: { x: 72, y: 72, width: 220, height: 44 },
      signerName: "Riley Morgan",
      signedAt: "2026-10-12T15:00:00.000Z",
      documentSha256: sha256Hex(original),
    };
    await expect(
      stampSignature(original, { ...base, typedName: "R", documentSha256: "0".repeat(64) }),
    ).rejects.toThrow(/changed after you reviewed/);
    await expect(stampSignature(original, { ...base, typedName: "R", image: png() })).rejects.toThrow(
      /Choose one/,
    );
    await expect(
      stampSignature(original, { ...base, typedName: "R", rect: { x: 500, y: 72, width: 220, height: 44 } }),
    ).rejects.toThrow(/isn't on the page/);
    await expect(stampSignature(original, { ...base, typedName: "R", pageIndex: 5 })).rejects.toThrow(/page/);
  });
});
