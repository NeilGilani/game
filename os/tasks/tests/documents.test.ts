import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { sha256Hex } from "../src/core/sha256";
import { ceremonyReducer, startCeremony, type CeremonyEvent } from "../src/documents/ceremony";
import { createPdfEngine, type PdfJsLike } from "../src/documents/pdf/index";
import { SAMPLE_DOCUMENTS, benefitsRenewalPdf } from "../src/documents/pdf/samples";
import { MemoryDocumentStore } from "../src/documents/types";
import { FakeSummarizer, proposeFills, quickFacts } from "../src/documents/understand";
import { SimulatedEmail } from "../src/email/transport";
import { createDocumentsPack } from "../src/packs/documents";
import { DEMO_PROFILE } from "../src/profile";
import { FakeSpeaker } from "../src/talk/speech";
import { ofType, runPack } from "./helpers";

const engine = createPdfEngine(pdfjs as unknown as PdfJsLike);

async function open(id: string, source: Parameters<typeof engine.load>[3] = { kind: "sample" }) {
  const sample = SAMPLE_DOCUMENTS.find((s) => s.id === id)!;
  return engine.load(id, sample.name, await sample.make(), source);
}

function deps(extra: Partial<Parameters<typeof createDocumentsPack>[0]> = {}) {
  const store = new MemoryDocumentStore();
  const email = new SimulatedEmail();
  const speaker = new FakeSpeaker();
  const summarizer = new FakeSummarizer("The benefits office wants you to renew by November 30.");
  return {
    store,
    email,
    speaker,
    summarizer,
    pack: createDocumentsPack({
      engine,
      store,
      email,
      speaker,
      summarizer,
      profile: DEMO_PROFILE,
      contacts: [{ name: "Benefits office", email: "renewals@benefits.example" }],
      now: () => new Date("2026-10-10T15:04:05.000Z"),
      ...extra,
    }),
  };
}

describe("PDF engine", () => {
  it("loads text, fields and hash", async () => {
    const doc = await open("benefits");
    expect(doc.pageCount).toBe(2);
    expect(doc.pages[0]).toMatch(/renew your disability support benefit/);
    expect(doc.fields.map((f) => f.name)).toEqual([
      "full_name",
      "date_of_birth",
      "address",
      "phone",
      "email",
      "applicant_signature",
    ]);
    expect(doc.fields[0]!.page).toBe(1);
    expect(doc.sha256).toBe(sha256Hex(await benefitsRenewalPdf()));
    expect(quickFacts(doc).join(" ")).toMatch(/November 30, 2026.*\$1,240.00|\$1,240.00/);
  });

  it("proposes fills from the profile and never secret fields", async () => {
    const doc = await open("benefits");
    const fills = proposeFills(
      [...doc.fields, { name: "ssn", type: "text" }, { name: "card_number", type: "text" }],
      DEMO_PROFILE,
    );
    expect(fills.map((f) => f.field)).toEqual(["full_name", "date_of_birth", "address", "phone", "email"]);
  });

  it("signs with a certificate page and refuses a changed document", async () => {
    const doc = await open("benefits");
    const req = {
      signerName: "Riley Morgan",
      style: "script" as const,
      intent: "I intend to sign.",
      signedAt: "2026-10-10T15:04:05.000Z",
      documentSha256: doc.sha256,
      documentName: doc.name,
      pageCount: 2,
    };
    const signed = await engine.sign(doc.bytes, req);
    const back = await engine.load("x", "x.pdf", signed, { kind: "sample" });
    expect(back.pageCount).toBe(3);
    expect(back.pages[2]).toMatch(/Signature certificate/);
    expect(back.pages[2]).toMatch(/Signed by eye-gaze confirmation in AGENCY/);
    expect(back.pages[2]!.replace(/\s+/g, "")).toContain(doc.sha256);
    expect(back.fields.find((f) => f.name === "applicant_signature")?.value).toBe("/s/ Riley Morgan");
    const tampered = new Uint8Array([...doc.bytes, 0x0a]);
    await expect(engine.sign(tampered, req)).rejects.toThrow(/changed after it was reviewed/);
  });
});

describe("signing ceremony", () => {
  const run = (events: CeremonyEvent[], pages = 2) => events.reduce(ceremonyReducer, startCeremony(pages));
  it("can't skip pages, style or either confirm", () => {
    expect(run([{ type: "next" }]).stage).toBe("pages");
    expect(run([{ type: "saw-page", index: 0 }, { type: "next" }]).stage).toBe("pages");
    const atAdopt = run([
      { type: "saw-page", index: 0 },
      { type: "saw-page", index: 1 },
      { type: "next" },
      { type: "next" },
      { type: "next" },
    ]);
    expect(atAdopt.stage).toBe("adopt");
    expect(ceremonyReducer(atAdopt, { type: "next" }).stage).toBe("adopt");
    const atConfirm = [
      { type: "adopt", style: "print" },
      { type: "next" },
      { type: "next" },
    ] as CeremonyEvent[];
    const s = atConfirm.reduce(ceremonyReducer, atAdopt);
    expect(s.stage).toBe("confirm");
    expect(ceremonyReducer(s, { type: "reconfirmed" }).stage).toBe("confirm");
    expect(ceremonyReducer(s, { type: "next" }).stage).toBe("confirm");
    const r = ceremonyReducer(s, { type: "confirmed" });
    expect(r.stage).toBe("reconfirm");
    expect(ceremonyReducer(r, { type: "back" }).stage).toBe("intent");
    expect(ceremonyReducer(r, { type: "reconfirmed" }).stage).toBe("approved");
  });
  it("puts the second confirm on the other side", () => {
    expect(startCeremony(1, "right").reconfirmSide).toBe("left");
    expect(startCeremony(1, "left").reconfirmSide).toBe("right");
  });
});

describe("documents pack", () => {
  it("explains with consent, fills, signs, saves and emails", async () => {
    const d = deps();
    d.store.put(await open("benefits"));
    const seen: string[] = [];
    const plan = ["explain", "fill", "sign"];
    const { events, last } = await runPack(
      d.pack,
      { goal: "Papers", selections: { pack: "documents", documentId: "benefits" } },
      {
        answer: (q) => {
          seen.push(q.prompt);
          if (q.prompt.startsWith("What would you like")) return plan.shift() ?? "done";
          if (q.prompt === "Who is signing?") return "self";
          if (q.prompt.startsWith("Choose how")) return "classic";
          if (q.prompt.includes("Email it")) return "c0";
          return q.options[0]!.id;
        },
      },
    );
    expect(last).toMatchObject({ type: "task.done", verified: true });
    const approvals = ofType(events, "approval.required").map((e) => e.approval);
    expect(approvals.map((a) => a.kind)).toEqual([
      "share-personal-data",
      "share-personal-data",
      "sign",
      "send",
    ]);
    // Consent shows exactly what is sent, and that is what the summarizer got.
    expect(approvals[0]!.preview?.data).toBe(d.summarizer.received[0]);
    expect(approvals[0]!.simulated).toBe(true);
    expect(approvals[2]!.details["Your statement"]).toMatch(
      /I, Riley Morgan, intend to sign "Benefits renewal.pdf"/,
    );
    const signed = d.store.signed("benefits")!;
    expect(signed.name).toBe("Benefits renewal (signed).pdf");
    const back = await engine.load("b", signed.name, signed.bytes, { kind: "sample" });
    expect(back.fields.find((f) => f.name === "full_name")?.value).toBe("Riley Morgan");
    expect(back.pages.at(-1)).toMatch(/2026-10-10T15:04:05.000Z/);
    expect(d.email.outbox[0]).toMatchObject({
      to: "renewals@benefits.example",
      subject: "Signed: Benefits renewal",
    });
    // The approved fingerprint covered the filled document, not the original.
    expect(approvals[2]!.details["Document fingerprint (SHA-256)"]).not.toBe(
      sha256Hex(await benefitsRenewalPdf()),
    );
  });

  it("declining consent sends nothing and offers quick facts", async () => {
    const d = deps();
    d.store.put(await open("benefits"));
    const { events } = await runPack(
      d.pack,
      { goal: "Papers", selections: { pack: "documents", documentId: "benefits", intent: "explain" } },
      { answer: () => "done", approve: () => "decline" },
    );
    expect(d.summarizer.received).toEqual([]);
    expect(ofType(events, "task.step").some((s) => /Nothing was sent. Quick facts/.test(s.summary))).toBe(
      true,
    );
  });

  it("reads pages aloud one at a time", async () => {
    const d = deps();
    d.store.put(await open("benefits"));
    await runPack(
      d.pack,
      { goal: "Papers", selections: { pack: "documents", documentId: "benefits", intent: "read" } },
      {
        answer: (q) => (q.options.some((o) => o.id === "next") ? "next" : "done"),
      },
    );
    expect(d.speaker.spoken.map((s) => s.text.slice(0, 7))).toEqual(["Page 1.", "Page 2."]);
  });

  it.each(["will", "poa", "affidavit"])("refuses to sign %s and explains", async (id) => {
    const d = deps();
    d.store.put(await open(id));
    const { last, events } = await runPack(d.pack, {
      goal: "Papers",
      selections: { pack: "documents", documentId: id, intent: "sign" },
    });
    expect(last).toMatchObject({ type: "task.failed", recoverable: false });
    expect(last.type === "task.failed" && last.reason).toMatch(/won't sign it.*What to do instead/);
    expect(ofType(events, "approval.required")).toEqual([]);
    expect(d.store.signed(id)).toBeUndefined();
  });

  it("refuses signing for someone else", async () => {
    const d = deps();
    d.store.put(await open("benefits"));
    const { last } = await runPack(
      d.pack,
      { goal: "Papers", selections: { pack: "documents", documentId: "benefits", intent: "sign" } },
      {
        answer: (q) => (q.prompt === "Who is signing?" ? "other" : "done"),
      },
    );
    expect(last.type === "task.failed" && last.reason).toMatch(/signed for someone else/);
  });

  it("flags instructions inside a document and never acts on them", async () => {
    const d = deps();
    d.store.put(await open("notice", { kind: "mail", from: "collections@example.com", subject: "Notice" }));
    const { events } = await runPack(
      d.pack,
      { goal: "Papers", selections: { pack: "documents", documentId: "notice" } },
      { answer: () => "done" },
    );
    expect(ofType(events, "task.step").some((s) => /text aimed at an AI assistant/.test(s.summary))).toBe(
      true,
    );
    expect(ofType(events, "approval.required")).toEqual([]);
    expect(d.email.outbox).toEqual([]);
  });

  it("without a summarizer only quick facts are offered, with no approval", async () => {
    const d = deps({ summarizer: undefined });
    d.store.put(await open("benefits"));
    const { events } = await runPack(
      d.pack,
      { goal: "Papers", selections: { pack: "documents", documentId: "benefits", intent: "explain" } },
      { answer: () => "done" },
    );
    expect(ofType(events, "approval.required")).toEqual([]);
    expect(ofType(events, "task.step").some((s) => /without AI/.test(s.summary))).toBe(true);
  });
});
