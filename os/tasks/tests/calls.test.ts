import { describe, expect, it } from "vitest";
import { SimulatedTransport, PHARMACY, DOCTOR } from "../src/calls/simulator";
import { disclosureText } from "../src/calls/transport";
import { FakeMemory } from "../src/memory/client";
import { createCallPack, HANG_UP } from "../src/packs/call";
import { DEMO_PROFILE } from "../src/profile";
import { ofType, runPack } from "./helpers";

function setup() {
  const transport = new SimulatedTransport();
  const memory = new FakeMemory();
  const pack = createCallPack({ transport, profile: DEMO_PROFILE, memory });
  return { transport, memory, pack };
}

describe("call pack", () => {
  it("calls the pharmacy, discloses first, refills by choosing replies", async () => {
    const { transport, pack, memory } = setup();
    const { events, last } = await runPack(
      pack,
      {
        goal: "Call the pharmacy",
        selections: { pack: "call", contactName: "Pharmacy", number: "(555) 555-0142" },
      },
      {
        answer: (q) => {
          const refill = q.options.find((o) =>
            /refill a prescription|Riley Morgan, born|usual prescription|Delivery|that's all/i.test(o.label),
          );
          return refill?.id ?? HANG_UP;
        },
      },
    );
    expect(last).toMatchObject({ type: "task.done", verified: true });
    const call = transport.calls[0]!;
    expect(call.said[0]).toEqual({
      who: "person",
      text: disclosureText({ personName: "Riley", mode: "tts" }),
    });
    expect(call.said.map((s) => s.text)).toContain("Riley Morgan, born March 3, 1984");
    expect(call.said.at(-1)?.text).toMatch(/goodbye/i);
    const approval = ofType(events, "approval.required")[0]!.approval;
    expect(approval.kind).toBe("call");
    expect(approval.simulated).toBe(true);
    expect(approval.details.Number).toBe("+1 (555) 555-0142");
    expect(approval.details["First thing said"]).toMatch(/text-to-speech/);
    expect(memory.events.map((e) => e.outcome)).toEqual(["chosen", "completed"]);
  });

  it.each(["911", "112", "988", "+44 999", "411"])(
    "refuses %s before asking for approval",
    async (number) => {
      const { transport, pack } = setup();
      const { events, last } = await runPack(pack, { goal: "Call", selections: { pack: "call", number } });
      expect(last).toMatchObject({ type: "task.failed", recoverable: false });
      expect(ofType(events, "approval.required")).toEqual([]);
      expect(transport.calls).toEqual([]);
    },
  );

  it("declining the approval makes no call", async () => {
    const { transport, pack } = setup();
    const { last } = await runPack(
      pack,
      { goal: "Call", selections: { pack: "call", number: "5555550123" } },
      { approve: () => "decline" },
    );
    expect(last).toMatchObject({ type: "task.done", outcome: "No call was made." });
    expect(transport.calls).toEqual([]);
  });

  it("books a doctor's appointment and the person can type their own words", async () => {
    const { transport, pack } = setup();
    let typed = false;
    await runPack(
      pack,
      { goal: "Call the doctor", selections: { pack: "call", contactName: "Clinic", number: DOCTOR.number } },
      {
        answer: (q) => {
          expect(q.allowOther).toBe(true);
          expect(q.options.length).toBeLessThanOrEqual(6);
          if (!typed) {
            typed = true;
            return { other: "I'd like to book an appointment please" };
          }
          return q.options.find((o) => /check-up|Tuesday|No, thank you/.test(o.label))?.id ?? HANG_UP;
        },
      },
    );
    const said = transport.calls[0]!.said.map((s) => s.text);
    expect(said).toContain("I'd like to book an appointment please");
    expect(said).toContain("Tuesday at 10 am");
  });

  it("never speaks a card number", async () => {
    const { transport, pack } = setup();
    let n = 0;
    await runPack(
      pack,
      { goal: "Call", selections: { pack: "call", number: PHARMACY.number } },
      { answer: () => (n++ === 0 ? { other: "my card is 4111 1111 1111 1111" } : HANG_UP) },
    );
    expect(transport.calls[0]!.said.map((s) => s.text).join(" ")).not.toMatch(/4111/);
    expect(transport.calls[0]!.state).toBe("ended");
  });

  it("stop hangs up the call", async () => {
    const { transport, pack } = setup();
    const { last } = await runPack(
      pack,
      { goal: "Call", selections: { pack: "call", number: PHARMACY.number } },
      { answer: () => null },
    );
    expect(last).toMatchObject({ type: "task.stopped" });
    expect(transport.calls[0]!.state).toBe("ended");
  });

  it("unknown numbers reach simulated voicemail", async () => {
    const { transport, pack } = setup();
    await runPack(pack, { goal: "Call", selections: { pack: "call", number: "+1 555 555 0111" } });
    expect(transport.calls[0]!.said[1]?.text).toMatch(/leave a message/);
  });

  it("a real task with only the simulator still says simulated", async () => {
    const { pack } = setup();
    const { events } = await runPack(
      pack,
      { goal: "Call", dryRun: false, selections: { pack: "call", number: PHARMACY.number } },
      { approve: () => "decline" },
    );
    expect(ofType(events, "approval.required")[0]!.approval.simulated).toBe(true);
  });

  it("the simulator refuses to start the script before the disclosure", async () => {
    const t = new SimulatedTransport();
    const call = await t.dial(PHARMACY.number, { disclosure: "Hello, TTS voice.", record: false });
    await expect(call.say("Hi")).rejects.toThrow(/disclosure/);
  });
});

describe("call ending", () => {
  it("answering after the other person hung up ends cleanly", async () => {
    const transport = new SimulatedTransport();
    const pack = createCallPack({ transport, profile: DEMO_PROFILE });
    // Always pick the first reply: the pharmacy eventually says goodbye and hangs up.
    const { last } = await runPack(pack, {
      goal: "Call",
      selections: { pack: "call", number: PHARMACY.number },
    });
    expect(last).toMatchObject({ type: "task.done", verified: true });
  });
});
