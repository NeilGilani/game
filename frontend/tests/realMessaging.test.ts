/**
 * Real texts and calls from the shell's side (state/realMessaging.ts with the practice agent): the Mac app's
 * messaging is faked here with the same ticket rules as os/desktop/src/main/messaging.ts (tested there). Off means
 * nothing real; the approval shown is the Mac app's ticket; only that exact fingerprint sends, once; Change makes a
 * new ticket; decline and Stop send nothing; failures are told as they are. No Messages app runs in these tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingApi,
  MessagingSettings,
  PrepareRequest,
  PrepareResult,
  SendResult,
} from "../../os/contracts/src/messaging";
import type { AgentEvent, ApprovalRequest, TaskRequest } from "../src/state/contracts";
import { FakeAgent } from "../src/state/fakeAgent";
import { FLOWS } from "../src/flows/library";
import { TYPE_ID, optionsOf, startFlow } from "../src/flows/engine";
import {
  REAL_CONTACT,
  messagingSource,
  realPeopleOptions,
  realScriptFor,
  refreshReal,
  setMessagingForTests,
} from "../src/state/realMessaging";

class FakeMain implements MessagingApi {
  settings: MessagingSettings = { enabled: true, textVia: "auto", callVia: "phone" };
  people = [{ id: "mom", name: "Mom", role: "family", display: "+1 (415) 555-0123" }];
  prepared: PrepareRequest[] = [];
  sent: { ticket: string; fingerprint: string }[] = [];
  cancelled: string[] = [];
  tickets = new Map<string, string>();
  prepareError: string | null = null;
  sendResult: SendResult = { ok: true, via: "imessage" };
  private n = 0;
  async status() {
    return { available: true, settings: this.settings, people: this.settings.enabled ? this.people : [] };
  }
  async setSettings(s: Partial<MessagingSettings>) {
    this.settings = { ...this.settings, ...s };
    return this.status();
  }
  async check() {
    return { imessage: true, sms: false, message: "ok" };
  }
  async prepare(req: PrepareRequest): Promise<PrepareResult> {
    this.prepared.push(req);
    if (this.prepareError) return { ok: false, error: this.prepareError };
    if (!this.settings.enabled) return { ok: false, error: "off" };
    this.n += 1;
    const ticket = `t${this.n}`;
    const fingerprint = `fp-${this.n}`;
    this.tickets.set(ticket, fingerprint);
    const text =
      req.kind === "text" ? req.text : req.textFirst ? "I'm calling you now through AGENCY." : null;
    return { ok: true, ticket, fingerprint, kind: req.kind, person: this.people[0]!, text, via: "auto" };
  }
  async send(ticket: string, fingerprint: string): Promise<SendResult> {
    const fp = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (fp !== fingerprint) return { ok: false, error: "mismatch" };
    this.sent.push({ ticket, fingerprint });
    return this.sendResult;
  }
  async cancel(ticket: string) {
    this.cancelled.push(ticket);
    this.tickets.delete(ticket);
  }
}

function collect(agent: FakeAgent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.onEvent((e) => events.push(e));
  return events;
}

async function until(events: AgentEvent[], type: AgentEvent["type"], count = 1): Promise<AgentEvent> {
  for (let i = 0; i < 400; i++) {
    const found = events.filter((e) => e.type === type);
    if (found.length >= count) return found[count - 1]!;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`no ${type} (saw ${events.map((e) => e.type).join(", ")})`);
}

const settle = () => new Promise((r) => setTimeout(r, 30));

const textToMom: TaskRequest = {
  id: "r1",
  goal: 'Send Mom a message: "Can you come by today?"',
  origin: "flow",
  dryRun: true,
  selections: { kind: "message", person: "Mom", [REAL_CONTACT]: "mom", text: "Can you come by today?" },
};

const callMom: TaskRequest = {
  id: "c1",
  goal: "Call Mom about: just to talk",
  origin: "flow",
  dryRun: true,
  selections: { kind: "call", pack: "call", person: "Mom", reason: "Just to talk", [REAL_CONTACT]: "mom" },
};

function decide(
  agent: FakeAgent,
  taskId: string,
  a: ApprovalRequest,
  decision: "approve" | "decline" | "change",
  fingerprint = a.fingerprint,
) {
  agent.send({ type: "approval.decide", taskId, decision: { approvalId: a.id, fingerprint, decision } });
}

afterEach(() => setMessagingForTests(undefined));

describe("without the Mac app, or while off, nothing is real", () => {
  it("the web demo never uses the Mac app's messaging, even if a page offers one", () => {
    const g = globalThis as unknown as { window?: unknown };
    const main = new FakeMain();
    g.window = {
      agency: { role: "shell", agent: { send: () => {}, onEvent: () => () => {} }, messaging: main },
    };
    try {
      expect(messagingSource()).toBe(main);
      vi.stubEnv("VITE_WEB_DEMO", "1");
      expect(messagingSource()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      delete g.window;
    }
  });

  it("practice tasks never take the real path", () => {
    setMessagingForTests(new FakeMain());
    expect(
      realScriptFor({ ...textToMom, selections: { kind: "message", person: "Mom", text: "hi" } }),
    ).toBeNull();
    expect(realScriptFor({ ...textToMom, selections: { kind: "food", [REAL_CONTACT]: "mom" } })).toBeNull();
  });

  it("a real person outside the Mac app is refused, never turned into practice", async () => {
    setMessagingForTests(null);
    expect(realPeopleOptions("say")).toEqual([]);
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request: textToMom });
    const failed = await until(events, "task.failed");
    expect(failed).toMatchObject({ reason: expect.stringContaining("Mac app") });
    expect(events.some((e) => e.type === "approval.required")).toBe(false);
  });

  it("while off, the flows show only practice people and a real task is refused", async () => {
    const main = new FakeMain();
    main.settings.enabled = false;
    setMessagingForTests(main);
    await refreshReal();
    expect(realPeopleOptions("why")).toEqual([]);
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request: textToMom });
    expect(await until(events, "task.failed")).toMatchObject({ reason: expect.stringContaining("off") });
    expect(main.prepared).toEqual([]);
  });
});

describe("real people in the flows", () => {
  it("come first, labelled Real; practice people stay, labelled Practice", async () => {
    setMessagingForTests(new FakeMain());
    await refreshReal();
    for (const id of ["call", "messages"]) {
      const flow = FLOWS[id]!;
      const options = optionsOf(flow, startFlow(flow));
      const own = options.filter((o) => o.id !== TYPE_ID);
      expect(own[0]).toMatchObject({ label: "Mom", sub: "Real · Family", set: { [REAL_CONTACT]: "mom" } });
      expect(own.slice(1).every((o) => o.sub?.startsWith("Practice"))).toBe(true);
      expect(own.slice(1).some((o) => o.set?.[REAL_CONTACT])).toBe(false);
    }
  });
});

describe("a real text needs the exact approval", () => {
  it("shows the Mac app's ticket, sends only that fingerprint, once, and says it can't see delivery", async () => {
    const main = new FakeMain();
    setMessagingForTests(main);
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request: textToMom });
    expect(await until(events, "task.started")).toMatchObject({ dryRun: false });
    const req = (await until(events, "approval.required")) as Extract<
      AgentEvent,
      { type: "approval.required" }
    >;
    const a = req.approval;
    expect(a.simulated).toBe(false);
    expect(a.fingerprint).toBe("fp-1");
    expect(a.details).toMatchObject({
      To: "Mom",
      Number: "+1 (415) 555-0123",
      Message: "Can you come by today?",
    });
    expect(a.preview).toEqual({ kind: "text", data: "Can you come by today?" });
    expect(main.prepared).toEqual([{ kind: "text", contactId: "mom", text: "Can you come by today?" }]);

    // A stale or forged fingerprint does nothing.
    decide(agent, "r1", a, "approve", "fp-forged");
    await settle();
    expect(main.sent).toEqual([]);

    decide(agent, "r1", a, "approve");
    const done = (await until(events, "task.done")) as Extract<AgentEvent, { type: "task.done" }>;
    expect(main.sent).toEqual([{ ticket: "t1", fingerprint: "fp-1" }]);
    expect(done.verified).toBe(false);
    expect(done.outcome).toMatch(/from your own number/);
    // Approving again changes nothing.
    decide(agent, "r1", a, "approve");
    await settle();
    expect(main.sent).toHaveLength(1);
  });

  it("Change makes a new ticket for the new words; the old fingerprint no longer counts", async () => {
    const main = new FakeMain();
    setMessagingForTests(main);
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request: textToMom });
    const first = (
      (await until(events, "approval.required")) as Extract<AgentEvent, { type: "approval.required" }>
    ).approval;
    decide(agent, "r1", first, "change");
    const which = (await until(events, "task.question")) as Extract<AgentEvent, { type: "task.question" }>;
    agent.send({ type: "task.answer", taskId: "r1", questionId: which.question.id, optionId: "Message" });
    const value = (await until(events, "task.question", 2)) as Extract<AgentEvent, { type: "task.question" }>;
    const thanks = value.question.options.find((o) => o.label === "Thank you!")!;
    agent.send({ type: "task.answer", taskId: "r1", questionId: value.question.id, optionId: thanks.id });
    const second = (
      (await until(events, "approval.required", 2)) as Extract<AgentEvent, { type: "approval.required" }>
    ).approval;
    expect(second.fingerprint).toBe("fp-2");
    expect(second.details.Message).toBe("Thank you!");
    expect(main.cancelled).toContain("t1");
    decide(agent, "r1", second, "approve", first.fingerprint);
    await settle();
    expect(main.sent).toEqual([]);
    decide(agent, "r1", second, "approve");
    await until(events, "task.done");
    expect(main.sent).toEqual([{ ticket: "t2", fingerprint: "fp-2" }]);
  });

  it("decline and Stop send nothing and forget the ticket", async () => {
    const main = new FakeMain();
    setMessagingForTests(main);
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request: textToMom });
    const a = (
      (await until(events, "approval.required")) as Extract<AgentEvent, { type: "approval.required" }>
    ).approval;
    decide(agent, "r1", a, "decline");
    expect(await until(events, "task.failed")).toMatchObject({
      reason: expect.stringContaining("Nothing was sent"),
    });

    agent.send({ type: "task.start", request: { ...textToMom, id: "r2" } });
    await until(events, "approval.required", 2);
    agent.send({ type: "stop.all" });
    await settle();
    expect(main.sent).toEqual([]);
    expect(main.cancelled).toEqual(["t1", "t2"]);
  });

  it("tells the Mac app's reason when it can't prepare or send", async () => {
    const main = new FakeMain();
    main.prepareError = "AGENCY never calls emergency or crisis lines.";
    setMessagingForTests(main);
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request: textToMom });
    expect(await until(events, "task.failed")).toMatchObject({ reason: main.prepareError });

    main.prepareError = null;
    main.sendResult = { ok: false, error: "AGENCY isn't allowed to use Messages yet." };
    agent.send({ type: "task.start", request: { ...textToMom, id: "r3" } });
    const a = (
      (await until(events, "approval.required")) as Extract<AgentEvent, { type: "approval.required" }>
    ).approval;
    decide(agent, "r3", a, "approve");
    expect(await until(events, "task.failed", 2)).toMatchObject({ reason: main.sendResult.error });
  });
});

describe("a real call", () => {
  it("offers to text first, with the exact note, and can be changed to no note", async () => {
    const main = new FakeMain();
    setMessagingForTests(main);
    const agent = new FakeAgent(1);
    const events = collect(agent);
    agent.send({ type: "task.start", request: callMom });
    const a = (
      (await until(events, "approval.required")) as Extract<AgentEvent, { type: "approval.required" }>
    ).approval;
    expect(a.kind).toBe("call");
    expect(a.details["Text first"]).toBe("I'm calling you now through AGENCY.");
    expect(main.prepared).toEqual([{ kind: "call", contactId: "mom", textFirst: true }]);
    decide(agent, "c1", a, "change");
    const which = (await until(events, "task.question")) as Extract<AgentEvent, { type: "task.question" }>;
    agent.send({
      type: "task.answer",
      taskId: "c1",
      questionId: which.question.id,
      optionId: "Before the call",
    });
    const value = (await until(events, "task.question", 2)) as Extract<AgentEvent, { type: "task.question" }>;
    agent.send({
      type: "task.answer",
      taskId: "c1",
      questionId: value.question.id,
      optionId: value.question.options[0]!.id,
    });
    const b = (
      (await until(events, "approval.required", 2)) as Extract<AgentEvent, { type: "approval.required" }>
    ).approval;
    expect(b.details["Text first"]).toBeUndefined();
    expect(main.prepared[1]).toEqual({ kind: "call", contactId: "mom", textFirst: false });
    main.sendResult = { ok: true, via: "phone" };
    decide(agent, "c1", b, "approve");
    const done = (await until(events, "task.done")) as Extract<AgentEvent, { type: "task.done" }>;
    expect(done.outcome).toMatch(/Talk/);
    expect(main.sent).toEqual([{ ticket: "t2", fingerprint: "fp-2" }]);
  });
});
