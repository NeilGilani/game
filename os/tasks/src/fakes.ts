/**
 * Fakes of everything this package provides or needs, so other instances can test without
 * the real thing: a PackAgent wired with every pack against simulated backends.
 */

import { SimulatedTransport } from "./calls/simulator";
import { PackAgent } from "./core/agent";
import { MemoryDocumentStore, type DocumentEngine } from "./documents/types";
import { FakeSummarizer } from "./documents/understand";
import { SimulatedEmail } from "./email/transport";
import { FakeMemory, type MemoryClient } from "./memory/client";
import { FakeSandboxStore } from "./ordering/store";
import { createPacks } from "./packs/index";
import { DEFAULT_LIMITS } from "./policy/money";
import { DEMO_PROFILE, type Profile } from "./profile";
import { FakeSpeaker, type Speaker } from "./talk/speech";

export interface FakeWorld {
  agent: PackAgent;
  speaker: Speaker;
  calls: SimulatedTransport;
  email: SimulatedEmail;
  store: FakeSandboxStore;
  documents: MemoryDocumentStore;
  memory: MemoryClient;
  summarizer: FakeSummarizer;
  profile: Profile;
}

/** Every pack on simulated backends. Pass a DocumentEngine (from "@agency/tasks/pdf") for Papers. */
export function createFakeWorld(
  opts: {
    engine?: DocumentEngine;
    speaker?: Speaker;
    memory?: MemoryClient;
    profile?: Profile;
    callDelayMs?: number;
    calls?: SimulatedTransport;
    store?: FakeSandboxStore;
    documents?: MemoryDocumentStore;
  } = {},
): FakeWorld {
  const speaker = opts.speaker ?? new FakeSpeaker();
  const memory = opts.memory ?? new FakeMemory();
  const profile = opts.profile ?? DEMO_PROFILE;
  const calls = opts.calls ?? new SimulatedTransport(undefined, opts.callDelayMs ?? 0);
  const email = new SimulatedEmail();
  const store = opts.store ?? new FakeSandboxStore();
  const documents = opts.documents ?? new MemoryDocumentStore();
  const summarizer = new FakeSummarizer(
    "Simulated summary: the Springfield Benefits Office asks you to renew your disability benefit by November 30, 2026, by checking your details, signing page 2 and sending it back. Your payment stays $1,240.00 a month if you renew.",
  );
  const engine: DocumentEngine = opts.engine ?? {
    load: async () => {
      throw new Error("No document engine: import createPdfEngine from @agency/tasks/pdf");
    },
    fill: async () => {
      throw new Error("No document engine");
    },
    sign: async () => {
      throw new Error("No document engine");
    },
  };
  const agent = new PackAgent(
    createPacks({
      talk: { speaker, memory },
      call: { transport: calls, profile, memory },
      documents: {
        engine,
        store: documents,
        profile,
        speaker,
        email,
        summarizer,
        memory,
        contacts: [
          { name: "Springfield Benefits Office", email: "renewals@benefits.example" },
          { name: "Jordan", email: "jordan@example.com" },
        ],
      },
      ordering: { store, limits: DEFAULT_LIMITS, memory },
    }),
  );
  return { agent, speaker, calls, email, store, documents, memory, summarizer, profile };
}
