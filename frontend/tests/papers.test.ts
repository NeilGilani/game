import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../os/tasks/src/core/sha256";
import { formSteps } from "../../os/tasks/src/documents/fields";
import type { PdfJsLike } from "../../os/tasks/src/documents/pdf/index";
import {
  checkFilled,
  checkSigned,
  fillForm,
  readForm,
  readValues,
  signatureSpots,
  stampSignature,
} from "../../os/tasks/src/documents/pdf/papers";
import { benefitsRenewalPdf } from "../../os/tasks/src/documents/pdf/samples";
import { choose, startFlow } from "../src/flows/engine";
import { FLOWS } from "../src/flows/library";
import { BASIC_NOTE_CHOSEN, BASIC_NOTE_OFF, explainLetter, type Poster } from "../src/papers/explain";
import { GateRefused, PapersGate, fingerprint, type Proposal } from "../src/papers/gate";
import { changedValues, fillProposal, signProposal } from "../src/papers/plans";
import { papersMode, setCurrentFolder } from "../src/papers/source";
import {
  cleanDetails,
  cloudExplainAllowed,
  loadDetails,
  saveDetails,
  setCloudExplain,
} from "../src/papers/store";

const js = pdfjs as unknown as PdfJsLike;

const LETTER = [
  "Springfield Benefits Office",
  "Your current monthly amount is $1,240.00. It will continue if you renew",
  "by November 30, 2026. If we don't receive this form, payments may stop.",
].join("\n");

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

afterEach(() => vi.unstubAllGlobals());

const proposal: Proposal = {
  kind: "fill",
  document: "Form.pdf",
  documentSha256: "a".repeat(64),
  details: { "1. Full name": "Riley Morgan" },
};

describe("the Papers gate", () => {
  it("an approval counts only for the exact action shown, once", async () => {
    const gate = new PapersGate();
    const fp = gate.propose(proposal);
    expect(gate.approve("not-it")).toBe(false);
    expect(gate.approve(fp)).toBe(true);
    // Something changed after the approval: it doesn't run.
    const changed = { ...proposal, details: { "1. Full name": "Someone else" } };
    const act = vi.fn(async () => "done");
    await expect(gate.perform(changed, act)).rejects.toBeInstanceOf(GateRefused);
    expect(act).not.toHaveBeenCalled();
    // The approval was used up by that attempt, so even the right action needs a new yes.
    await expect(gate.perform(proposal, act)).rejects.toThrow(/wasn't the action you approved/);
    expect(gate.approve(fp)).toBe(true);
    expect(await gate.perform(proposal, act)).toBe("done");
    await expect(gate.perform(proposal, act)).rejects.toBeInstanceOf(GateRefused);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("a new proposal cancels an earlier approval", () => {
    const gate = new PapersGate();
    const fp = gate.propose(proposal);
    gate.propose({ ...proposal, kind: "sign" });
    expect(gate.approve(fp)).toBe(false);
  });

  it("Stop aborts what's running and nothing more happens", async () => {
    const gate = new PapersGate();
    const fp = gate.propose(proposal);
    gate.approve(fp);
    const save = vi.fn();
    const running = gate.perform(proposal, async (signal) => {
      await new Promise((r) => setTimeout(r, 5));
      expect(signal.aborted).toBe(true);
      gate.check(); // the last step before writing: refuses after Stop
      save();
    });
    gate.stop();
    await expect(running).rejects.toThrow(/Stopped/);
    expect(save).not.toHaveBeenCalled();
    expect(gate.approve(fp)).toBe(false);
    gate.reset();
    expect(gate.approve(gate.propose(proposal))).toBe(true);
  });

  it("fingerprints differ for any difference in what was shown", () => {
    expect(fingerprint(proposal)).toBe(fingerprint({ ...proposal, details: { ...proposal.details } }));
    expect(fingerprint(proposal)).not.toBe(fingerprint({ ...proposal, documentSha256: "b".repeat(64) }));
  });
});

describe("explaining a letter: the privacy switch and the checks", () => {
  it("with cloud explanation off, nothing is sent at all", async () => {
    const post = vi.fn<Poster>();
    const r = await explainLetter(LETTER, { cloud: false, signal: new AbortController().signal, post });
    expect(post).not.toHaveBeenCalled();
    expect(r.explanation.source).toBe("basic");
    expect(r.note).toBe(BASIC_NOTE_OFF);
    expect(r.explanation.amounts[0]?.text).toBe("Amount: $1,240.00");
    const chosen = await explainLetter(LETTER, {
      cloud: false,
      signal: new AbortController().signal,
      post,
      reason: "chosen",
    });
    expect(chosen.note).toBe(BASIC_NOTE_CHOSEN);
  });

  it("sends only the text, and drops any fact whose quote isn't in the letter", async () => {
    const post = vi.fn<Poster>(async () => ({
      status: 200,
      body: {
        label: "Gemini (test)",
        explanation: {
          what: "A renewal letter.",
          from: "Springfield Benefits Office",
          wants: "Renew by sending the form.",
          deadlines: [
            { text: "Renew by November 30, 2026", quote: "by November 30, 2026" },
            { text: "Pay by October 1, 2026", quote: "Pay by October 1, 2026" },
          ],
          amounts: [],
          next_steps: ["Check page 2"],
        },
      },
    }));
    const r = await explainLetter(LETTER, { cloud: true, signal: new AbortController().signal, post });
    expect(post).toHaveBeenCalledWith("/api/assist/letter", { text: LETTER }, expect.anything());
    expect(r.explanation.deadlines.map((d) => d.text)).toEqual(["Renew by November 30, 2026"]);
    expect(r.explanation.dropped).toBe(1);
    expect(r.label).toBe("Gemini (test)");
  });

  it("falls back to the basics, honestly, when Gemini is unavailable", async () => {
    const r = await explainLetter(LETTER, {
      cloud: true,
      signal: new AbortController().signal,
      post: async () => ({ status: 503, body: null }),
    });
    expect(r.explanation.source).toBe("basic");
    expect(r.note).toMatch(/Gemini isn't set up/);
  });

  it("Stop cancels the request", async () => {
    const c = new AbortController();
    const post: Poster = (_p, _b, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const pending = explainLetter(LETTER, { cloud: true, signal: c.signal, post });
    c.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("the switch is on unless a helper turns it off, and is remembered", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(cloudExplainAllowed()).toBe(true);
    setCloudExplain(false);
    expect(cloudExplainAllowed()).toBe(false);
    setCloudExplain(true);
    expect(cloudExplainAllowed()).toBe(true);
  });
});

describe("saved details", () => {
  it("keep only what was entered, and nothing when empty", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(cleanDetails({ fullName: "  ", phone: "" })).toBeNull();
    expect(
      saveDetails({
        fullName: " Ada Lovelace ",
        phone: "",
        address: { line1: "", city: "", region: "", postalCode: "" },
      }),
    ).toEqual({
      fullName: "Ada Lovelace",
      preferredName: "Ada",
    });
    expect(loadDetails()?.fullName).toBe("Ada Lovelace");
    saveDetails(null);
    expect(loadDetails()).toBeNull();
  });
});

describe("filling and signing through the gate", () => {
  const details = { fullName: "Ada Lovelace", preferredName: "Ada", phone: "+1 555 0100" };

  it("saves exactly the reviewed answers, and refuses answers changed after the yes", async () => {
    const bytes = await benefitsRenewalPdf();
    const doc = { name: "Benefits renewal.pdf", sha256: sha256Hex(bytes) };
    const steps = formSteps(await readForm(bytes), details);
    const answers = Object.fromEntries(steps.map((s) => [s.field.name, s.suggestions[0]?.value ?? ""]));
    expect(changedValues(steps, answers)).toEqual({ full_name: "Ada Lovelace", phone: "+1 555 0100" });

    const gate = new PapersGate();
    const { proposal: shown } = fillProposal(doc, steps, answers);
    expect(gate.approve(gate.propose(shown))).toBe(true);
    const saved: Uint8Array[] = [];
    const save = async (out: Uint8Array) => {
      saved.push(out);
      return { name: "Benefits renewal-filled.pdf" };
    };
    // The person's answers are edited after the approval (a bug, a race): nothing is filled or saved.
    const edited = fillProposal(doc, steps, { ...answers, phone: "+1 555 9999" });
    await expect(
      gate.perform(edited.proposal, async () => save(await fillForm(bytes, edited.values))),
    ).rejects.toThrow(GateRefused);
    expect(saved).toHaveLength(0);

    expect(gate.approve(gate.propose(shown))).toBe(true);
    const { values } = fillProposal(doc, steps, answers);
    await gate.perform(shown, async () => {
      const out = await fillForm(bytes, values);
      expect(await checkFilled(out, values)).toEqual([]);
      return save(out);
    });
    expect(saved).toHaveLength(1);
    expect(await readValues(saved[0]!)).toMatchObject({
      full_name: "Ada Lovelace",
      phone: "+1 555 0100",
      email: "",
    });
  });

  it("signs only the approved place, and refuses another place", async () => {
    const bytes = await benefitsRenewalPdf();
    const doc = { name: "Benefits renewal.pdf", sha256: sha256Hex(bytes) };
    const spots = await signatureSpots(js, bytes, 1);
    const [box, other] = [spots[0]!, spots.at(-1)!];
    const sig = { kind: "typed" as const, name: "Ada Lovelace" };
    const gate = new PapersGate();
    const fp = gate.propose(signProposal(doc, 1, box, sig, "Ada Lovelace"));
    expect(gate.approve(fp)).toBe(true);
    const stamp = (spot: typeof box) => {
      const req = {
        pageIndex: 1,
        rect: spot.rect,
        typedName: "Ada Lovelace",
        signerName: "Ada Lovelace",
        signedAt: "2026-10-12T15:00:00.000Z",
        documentSha256: doc.sha256,
      };
      return stampSignature(bytes, req).then(async (out) => ({
        out,
        check: await checkSigned(js, bytes, out, req),
      }));
    };
    await expect(
      gate.perform(signProposal(doc, 1, other, sig, "Ada Lovelace"), () => stamp(other)),
    ).rejects.toThrow(GateRefused);
    expect(gate.approve(gate.propose(signProposal(doc, 1, box, sig, "Ada Lovelace")))).toBe(true);
    const { check } = await gate.perform(signProposal(doc, 1, box, sig, "Ada Lovelace"), () => stamp(box));
    expect(check).toEqual({ ok: true });
  });
});

describe("the Papers flow", () => {
  it("stays on the practice documents in tests and the web demo", () => {
    expect(papersMode()).toBe("practice");
    const f = FLOWS.papers!;
    expect(choose(f, startFlow(f), "sign").screenId).toBe("which");
  });

  it("goes to the real Papers screens in a plain browser", () => {
    vi.stubGlobal("window", {});
    expect(papersMode()).toBe("picker");
    const f = FLOWS.papers!;
    expect(choose(f, startFlow(f), "sign").outcome).toEqual({ type: "route", path: "/papers/sign" });
    expect(choose(f, startFlow(f), "fill").outcome).toEqual({ type: "route", path: "/papers/fill" });
    expect(choose(f, startFlow(f), "errands").outcome).toEqual({ type: "route", path: "/errands" });
  });

  it("in the Mac app, only once a helper chose a folder", () => {
    const agency = { agent: { send: () => {} }, papers: { folder: async () => null } };
    vi.stubGlobal("window", { agency });
    expect(papersMode()).toBe("practice");
    setCurrentFolder({ display: "~/Documents/AGENCY Papers" });
    expect(papersMode()).toBe("folder");
    const f = FLOWS.papers!;
    expect(choose(f, startFlow(f), "explain").outcome).toEqual({ type: "route", path: "/papers/explain" });
    setCurrentFolder(null);
  });
});
