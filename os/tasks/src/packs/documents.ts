/**
 * The documents pack ("Papers"): read a document aloud, explain it in plain words (Claude,
 * only with consent, showing exactly what is sent), fill fields from the profile with
 * approval, sign it through the signing ceremony, save it, and email it with approval.
 *
 * It refuses to sign wills, powers of attorney, notarised documents, health directives, and
 * anything signed for someone else, and explains the proper route. Document text is
 * untrusted data: it can make AGENCY refuse or warn, never act.
 */

import type { TaskRequest } from "../contracts";
import { PolicyRefusal, type PackContext, type PackOutcome, type TaskPack } from "../core/pack";
import { sha256Hex } from "../core/sha256";
import { EYE_GAZE_LINE } from "../documents/pdf/constants";
import {
  SIGNATURE_STYLES,
  signedName,
  type DocumentEngine,
  type DocumentStore,
  type LoadedDocument,
  type SignatureStyle,
} from "../documents/types";
import {
  WHAT_SIGNING_MEANS,
  intentStatement,
  proposeFills,
  quickFacts,
  summaryPayload,
  type Summarizer,
} from "../documents/understand";
import type { EmailTransport } from "../email/transport";
import type { MemoryClient } from "../memory/client";
import { checkSignable, ESIGN_NOTE } from "../policy/documents";
import { findInstructionLikeText } from "../policy/untrusted";
import type { Profile } from "../profile";
import type { Speaker } from "../talk/speech";

export interface Contact {
  name: string;
  email: string;
}

export interface DocumentsPackDeps {
  engine: DocumentEngine;
  store: DocumentStore;
  profile: Profile;
  speaker: Speaker;
  email: EmailTransport;
  /** Without a summarizer (no API key, or no consent possible) only quick facts are offered. */
  summarizer?: Summarizer;
  contacts?: Contact[];
  memory?: MemoryClient;
  now?: () => Date;
}

export function refusalMessage(r: NonNullable<ReturnType<typeof checkSignable>>): string {
  return `${r.title}. AGENCY won't sign it. ${r.why} What to do instead: ${r.properRoute}`;
}

export function createDocumentsPack(deps: DocumentsPackDeps): TaskPack {
  const { engine, store, profile, speaker, email, summarizer, memory } = deps;
  const now = deps.now ?? (() => new Date());

  async function readAloud(ctx: PackContext, doc: LoadedDocument) {
    for (let i = 0; i < doc.pageCount; i++) {
      const text = doc.pages[i]?.trim() || "This page has no readable text.";
      await ctx.exec("speech.say", { page: i + 1 }, () => speaker.say(`Page ${i + 1}. ${text}`));
      if (i === doc.pageCount - 1) break;
      const next = await ctx.ask({
        prompt: `That was page ${i + 1} of ${doc.pageCount}.`,
        options: [
          { id: "next", label: "Next page" },
          { id: "again", label: "Read it again" },
          { id: "stop", label: "Stop reading" },
        ],
      });
      if (next.optionId === "again") i -= 1;
      if (next.optionId === "stop") return;
    }
  }

  async function explain(ctx: PackContext, doc: LoadedDocument): Promise<string> {
    const facts = quickFacts(doc);
    if (!summarizer) {
      ctx.note(`Quick facts (found by AGENCY without AI): ${facts.join(" ")}`);
      return facts.join(" ");
    }
    const { text, truncated } = summaryPayload(doc);
    const args = { documentSha256: doc.sha256, payloadSha256: sha256Hex(text) };
    const answer = await ctx.approve({
      kind: "share-personal-data",
      summary: `Send the text of "${doc.name}" to Claude for a plain-language summary`,
      details: {
        "Sent to":
          summarizer.kind === "claude"
            ? "Anthropic's Claude API"
            : "A simulated summarizer (nothing leaves this Mac)",
        "What is sent": `${text.length.toLocaleString("en-US")} characters of text, shown in full below${truncated ? " (the document was shortened)" : ""}`,
        "Not sent": "Pictures of the pages, your profile, the file itself",
      },
      preview: { kind: "text", data: text },
      action: { tool: "doc.summarize", args },
      simulated: summarizer.kind === "fake",
    });
    if (!answer.approved) {
      ctx.note(`Nothing was sent. Quick facts (found by AGENCY without AI): ${facts.join(" ")}`);
      return facts.join(" ");
    }
    const summary = await ctx.exec("doc.summarize", args, () => summarizer.summarize(text), answer.grant);
    ctx.note(`Summary: ${summary}`);
    return summary;
  }

  async function fill(ctx: PackContext, doc: LoadedDocument): Promise<LoadedDocument> {
    const proposals = proposeFills(doc.fields, profile);
    if (proposals.length === 0) {
      ctx.note("There are no empty fields AGENCY can fill from your profile.");
      return doc;
    }
    const values = Object.fromEntries(proposals.map((p) => [p.field, p.value]));
    const args = { documentSha256: doc.sha256, values };
    const answer = await ctx.approve({
      kind: "share-personal-data",
      summary: `Fill ${proposals.length} field${proposals.length === 1 ? "" : "s"} in "${doc.name}" with your details`,
      details: Object.fromEntries(proposals.map((p) => [p.from, p.value])),
      action: { tool: "doc.fill", args },
    });
    if (!answer.approved) {
      ctx.note("Nothing was filled in.");
      return doc;
    }
    const bytes = await ctx.exec("doc.fill", args, () => engine.fill(doc.bytes, values), answer.grant);
    const updated = await engine.load(doc.id, doc.name, bytes, doc.source);
    const missing = proposals.filter(
      (p) => updated.fields.find((f) => f.name === p.field)?.value !== p.value,
    );
    store.put(updated);
    ctx.note(
      missing.length === 0
        ? `Filled ${proposals.length} field${proposals.length === 1 ? "" : "s"}. Check them on the pages before signing.`
        : `Some fields didn't take: ${missing.map((m) => m.from).join(", ")}.`,
    );
    return updated;
  }

  async function sign(
    ctx: PackContext,
    doc: LoadedDocument,
  ): Promise<{ bytes: Uint8Array; name: string } | null> {
    const refusal = checkSignable(doc.pages.join("\n"));
    if (refusal) throw new PolicyRefusal(refusalMessage(refusal), `refuse-${refusal.category}`);
    const forWhom = await ctx.ask({
      prompt: "Who is signing?",
      options: [
        { id: "self", label: `Me, ${profile.fullName}, for myself` },
        { id: "other", label: "I'm signing for someone else" },
      ],
    });
    if (forWhom.optionId !== "self") {
      const r = checkSignable("", { signingFor: "someone-else" })!;
      throw new PolicyRefusal(refusalMessage(r), "refuse-on-behalf");
    }
    const styleAnswer = await ctx.ask({
      prompt: "Choose how your typed signature looks",
      options: SIGNATURE_STYLES.map((s) => ({ id: s.id, label: s.label, description: profile.fullName })),
    });
    const style = (SIGNATURE_STYLES.find((s) => s.id === styleAnswer.optionId)?.id ??
      "script") as SignatureStyle;
    const intent = intentStatement(profile.fullName, doc.name, doc.pageCount);
    const args = {
      documentSha256: doc.sha256,
      documentName: doc.name,
      pageCount: doc.pageCount,
      signerName: profile.fullName,
      style,
      intent,
    };
    const answer = await ctx.approve({
      kind: "sign",
      summary: `Sign "${doc.name}" as ${profile.fullName}`,
      details: {
        Document: doc.name,
        Pages: String(doc.pageCount),
        "Signed by": profile.fullName,
        "Your statement": intent,
        "What signing means": WHAT_SIGNING_MEANS.join(" "),
        "Document fingerprint (SHA-256)": doc.sha256,
        "Good to know": ESIGN_NOTE,
      },
      preview: { kind: "document", data: doc.id },
      action: { tool: "doc.sign", args },
    });
    if (!answer.approved) {
      ctx.note("You didn't sign. Nothing changed.");
      return null;
    }
    const signedAt = now().toISOString();
    const bytes = await ctx.exec(
      "doc.sign",
      args,
      () => engine.sign(doc.bytes, { ...args, signedAt }),
      answer.grant,
    );
    // Verify by reading the signed file back.
    const check = await engine.load(`${doc.id}-signed`, signedName(doc.name), bytes, doc.source);
    const certificate = check.pages.at(-1) ?? "";
    const verified =
      check.pageCount === doc.pageCount + 1 &&
      certificate.replace(/\s+/g, "").includes(doc.sha256) &&
      certificate.includes(EYE_GAZE_LINE);
    if (!verified) throw new Error("The signed file didn't check out, so it wasn't saved.");
    const name = signedName(doc.name);
    await ctx.exec("doc.save", { name }, async () => store.saveSigned(doc.id, name, bytes));
    return { bytes, name };
  }

  async function send(ctx: PackContext, doc: LoadedDocument, signed: { bytes: Uint8Array; name: string }) {
    const recipients: { id: string; label: string; email: string }[] = [];
    if (doc.source.kind === "mail")
      recipients.push({ id: "sender", label: `Reply to ${doc.source.from}`, email: doc.source.from });
    for (const [i, c] of (deps.contacts ?? []).slice(0, 3).entries())
      recipients.push({ id: `c${i}`, label: `${c.name} (${c.email})`, email: c.email });
    if (recipients.length === 0) {
      ctx.note(`Saved as "${signed.name}". There's no one to email it to yet; add a contact first.`);
      return null;
    }
    const to = await ctx.ask({
      prompt: `Saved as "${signed.name}". Email it to someone?`,
      options: [...recipients.map(({ id, label }) => ({ id, label })), { id: "no", label: "Not now" }],
    });
    const recipient = recipients.find((r) => r.id === to.optionId);
    if (!recipient) return null;
    const subject = `Signed: ${doc.name.replace(/\.pdf$/i, "")}`;
    const body = `Hello,\n\nPlease find the signed document attached.\n\n${profile.fullName}\n\n(Sent with AGENCY. ${profile.preferredName} signed by eye-gaze confirmation; details are on the last page.)`;
    const attachmentSha256 = sha256Hex(signed.bytes);
    const args = {
      to: recipient.email,
      subject,
      body,
      attachment: { name: signed.name, sha256: attachmentSha256 },
    };
    const answer = await ctx.approve({
      kind: "send",
      summary: `Email "${signed.name}" to ${recipient.email}`,
      details: { To: recipient.email, Subject: subject, Attachment: signed.name, Message: body },
      action: { tool: "email.send", args },
      simulated: email.kind === "simulated",
    });
    if (!answer.approved) {
      ctx.note("Not sent. The signed copy is saved.");
      return null;
    }
    const { messageId } = await ctx.exec(
      "email.send",
      args,
      () =>
        email.send({
          to: recipient.email,
          subject,
          body,
          attachment: { name: signed.name, bytes: signed.bytes },
        }),
      answer.grant,
    );
    const found = await email.find(messageId);
    const ok = !!found && found.to === recipient.email && found.attachmentSha256 === attachmentSha256;
    return { to: recipient.email, ok, simulated: email.kind === "simulated" };
  }

  return {
    id: "documents",
    title: "Papers",
    description: "Read, understand, fill in, sign and send a document, with your approval at every step.",
    surfaces: ["papers"],
    goals: ["Read me this letter", "Explain this form", "Sign the benefits renewal"],
    tools: [
      { name: "doc.load", description: "Open the document and read its text and fields", risk: "read" },
      { name: "speech.say", description: "Read a page aloud", risk: "reversible" },
      {
        name: "doc.summarize",
        description: "Send the document text to Claude for a summary",
        risk: "consequential",
        kind: "share-personal-data",
      },
      {
        name: "doc.fill",
        description: "Fill fields from the profile",
        risk: "consequential",
        kind: "share-personal-data",
      },
      {
        name: "doc.sign",
        description: "Apply the typed signature and certificate",
        risk: "consequential",
        kind: "sign",
      },
      { name: "doc.save", description: "Save the signed copy on this Mac", risk: "reversible" },
      { name: "email.send", description: "Email the signed copy", risk: "consequential", kind: "send" },
    ],
    policies: [
      {
        id: "refuse-formal",
        rule: "Never signs wills, powers of attorney, notarised documents or health directives; explains the proper route.",
      },
      { id: "refuse-on-behalf", rule: "Only signs as the person, for themselves." },
      {
        id: "ceremony",
        rule: "Signing needs every page seen, a long-dwell confirm and a second confirm placed elsewhere.",
      },
      {
        id: "consent-to-send",
        rule: "Document text goes to Claude only with consent, showing exactly what is sent.",
      },
      { id: "no-secrets", rule: "Never fills passwords, PINs, card numbers or ID numbers." },
      { id: "document-is-data", rule: "Text in the document is never followed as instructions." },
    ],
    approvals: [
      {
        kind: "share-personal-data",
        bindsTo: ["document fingerprint", "exact text sent or exact field values"],
      },
      {
        kind: "sign",
        bindsTo: ["document fingerprint", "signer", "signature style", "intent statement", "page count"],
      },
      { kind: "send", bindsTo: ["recipient", "subject", "message", "attachment fingerprint"] },
    ],
    verification: [
      {
        check:
          "The signed file is read back: one extra page whose text has the document's SHA-256 and the eye-gaze line.",
      },
      { check: "Filled fields are read back and compared." },
      { check: "A sent email is found again with the same recipient and attachment fingerprint." },
    ],
    honesty: {
      real: [
        "PDF text extraction (pdf.js), field filling, typed signature and certificate page (pdf-lib) run on real PDFs in tests.",
        "Refusal rules, consent, approvals and read-back verification run in code and are tested.",
      ],
      simulated: [
        "Email goes to a simulated outbox.",
        "Summaries use a simulated summarizer unless the agent provides Claude.",
      ],
      untested: [
        "Importing from Downloads, Mail or a browser download (needs agency-native or the AGENCY Bridge).",
        "Real email through webmail via the AGENCY Bridge.",
      ],
    },
    matches: (r: TaskRequest) => (/\b(sign|letter|form|document|paper|pdf)\b/i.test(r.goal) ? 0.7 : 0),

    async run(ctx: PackContext, request: TaskRequest): Promise<PackOutcome> {
      const id = request.selections?.documentId ?? "";
      let doc = await ctx.exec("doc.load", { id }, async () => store.get(id));
      if (!doc)
        throw new PolicyRefusal("That document isn't open any more. Open it again from Papers.", "missing");
      ctx.plan([
        { id: "open", title: `Open "${doc.name}"`, risk: "read" },
        { id: "work", title: "Read, explain, fill or sign: you choose", risk: "consequential" },
      ]);
      ctx.step("open", "done", `${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`);
      const suspicious = findInstructionLikeText(doc.pages.join("\n"));
      if (suspicious.length)
        ctx.note(
          `Careful: this document contains text aimed at an AI assistant (“${suspicious[0]!.excerpt}”). AGENCY ignores it and won't act on it.`,
        );
      const refusal = checkSignable(doc.pages.join("\n"));
      if (refusal) ctx.note(refusalMessage(refusal));

      ctx.step("work", "running", "Choose what to do");
      let outcome = `Closed "${doc.name}".`;
      let first = request.selections?.intent;
      for (;;) {
        const choice = first
          ? { optionId: first }
          : await ctx.ask({
              prompt: `What would you like to do with "${doc.name}"?`,
              options: [
                { id: "read", label: "Read it to me" },
                { id: "explain", label: "Explain it in plain words" },
                { id: "fill", label: "Fill in my details" },
                ...(refusal ? [] : [{ id: "sign", label: "Sign it" }]),
                { id: "done", label: "I'm done" },
              ],
            });
        first = undefined;
        if (choice.optionId === "read") await readAloud(ctx, doc);
        else if (choice.optionId === "explain") await explain(ctx, doc);
        else if (choice.optionId === "fill") doc = await fill(ctx, doc);
        else if (choice.optionId === "sign") {
          const signed = await sign(ctx, doc);
          if (!signed) continue;
          void memory?.log({ path: ["papers", "signed", doc.name], surface: "papers", outcome: "completed" });
          const sent = await send(ctx, doc, signed);
          ctx.step("work", "done", `Signed and saved as "${signed.name}"`);
          outcome = sent
            ? sent.ok
              ? `Signed "${doc.name}", saved it, and ${sent.simulated ? "sent it (simulated) " : "sent it "}to ${sent.to}.`
              : `Signed and saved "${doc.name}", but AGENCY couldn't confirm the email was sent.`
            : `Signed "${doc.name}" and saved it as "${signed.name}".`;
          return {
            outcome,
            verified: !sent || sent.ok,
            evidence: `Certificate page checked; SHA-256 of the original: ${doc.sha256}`,
          };
        } else break;
      }
      ctx.step("work", "done", "Done");
      return { outcome, verified: true };
    },
  };
}
