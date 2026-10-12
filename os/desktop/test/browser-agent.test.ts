/**
 * The assistant's tools on AGENCY Browser (main/browser/agent.ts): on their own, and under the real agent runtime
 * and guard (os/agent), exactly as the Mac app wires them (bridge rpc -> AgentBrowser). A fake page stands in for
 * the page preload; its records say what really happened on the page.
 */

import type { AgentEvent } from "@agency/contracts";
import { describe, expect, it } from "vitest";
import { ScriptedModel, type ScriptTurn } from "../../agent/src/model/scripted";
import { DEFAULT_SETTINGS, type SafetySettings } from "../../agent/src/policy/settings";
import { AgentRuntime } from "../../agent/src/runtime/runtime";
import type { BrowserBridge, BridgeResult, PageSnapshot } from "../../agent/src/types";
import { AgentBrowser, approvalKind, type AgentTab } from "../src/main/browser/agent";

interface Node {
  ref: string;
  role: string;
  name: string;
  value?: string;
  secure?: boolean;
  href?: string;
  consequential?: string | null;
}

/** A page as the preload would report it, and a record of what was done to it. */
class FakePage {
  done: string[] = [];
  captcha = false;
  /** Changes the page between describe calls (an approval no longer matches). */
  drift = 0;
  constructor(
    public url: string,
    public nodes: Node[],
    public extraText = "",
  ) {}
  tab(): AgentTab {
    return {
      id: 7,
      url: () => this.url,
      call: async <T>(method: string, p: Record<string, unknown> = {}) => {
        const node = this.nodes.find((n) => n.ref === p.ref);
        switch (method) {
          case "agent.tree":
            return {
              url: this.url,
              title: "Page",
              nodes: [
                ...this.nodes.map((n) => ({
                  ref: n.ref,
                  role: n.role,
                  name: n.name,
                  ...(n.value !== undefined ? { value: n.value } : {}),
                  state: n.secure ? { secure: true } : {},
                  ...(n.href ? { href: n.href } : {}),
                })),
                ...(this.extraText ? [{ ref: "t", role: "text", name: this.extraText, state: {} }] : []),
              ],
            } as T;
          case "agent.describe":
            if (!node) throw new Error("no element");
            return {
              name: node.name,
              role: node.role,
              consequential: node.consequential ?? null,
              key: `key-${node.ref}-${this.drift}`,
            } as T;
          case "agent.captcha":
            return this.captcha as T;
          case "agent.click":
            if (!node) throw new Error("no element");
            this.done.push(`click ${node.name}${p.key ? " (approved)" : ""}`);
            if (node.name === "Place order") this.extraText = "Order confirmed. Number 4471.";
            return true as T;
          case "agent.type":
            if (!node || node.secure) throw new Error("secure field");
            this.done.push(`type ${node.name}: ${String(p.text)}`);
            node.value = String(p.text);
            return true as T;
          case "agent.select":
            this.done.push(`select ${String(p.option)}`);
            return true as T;
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
      load: async (url) => {
        this.done.push(`open ${url}`);
        this.url = url;
      },
      settle: async () => undefined,
    };
  }
}

function browserFor(page: FakePage, internal: string[] = []) {
  const helper: string[] = [];
  const ab = new AgentBrowser({
    tab: async () => page.tab(),
    internalOrigins: () => internal,
    helperNeeded: (why) => helper.push(why),
  });
  return { ab, helper };
}

const shop = () =>
  new FakePage(
    "https://shop.example/checkout",
    [
      { ref: "n1", role: "textbox", name: "Note for the driver" },
      { ref: "pw", role: "textbox", name: "Password", secure: true, value: "hunter2" },
      { ref: "l1", role: "link", name: "Help", href: "javascript:alert(1)" },
      { ref: "l2", role: "link", name: "Returns", href: "https://shop.example/returns" },
      { ref: "si", role: "button", name: "Sign in" },
      { ref: "po", role: "button", name: "Place order", consequential: "purchase" },
      { ref: "more", role: "button", name: "Show more" },
    ],
    "Order total $12.00",
  );

describe("AgentBrowser on its own", () => {
  it("reads the page like the Chrome bridge: no secret values, only web links, sandbox pages marked", async () => {
    const page = shop();
    const { ab } = browserFor(page);
    const snap = (await ab.call("snapshot", {})) as PageSnapshot;
    expect(snap).toMatchObject({
      tabId: "7",
      url: page.url,
      origin: "https://shop.example",
      simulated: false,
    });
    const pw = snap.nodes.find((n) => n.ref === "pw")!;
    expect(pw.secure).toBe(true);
    expect(pw.value).toBeUndefined();
    expect(snap.nodes.find((n) => n.ref === "l1")!.href).toBeUndefined();
    expect(snap.nodes.find((n) => n.ref === "l2")!.href).toBe("https://shop.example/returns");
    expect(snap.text).toContain("Order total $12.00");
    const local = new FakePage("http://food.localhost:8787/", []);
    expect(((await browserFor(local).ab.call("snapshot", {})) as PageSnapshot).simulated).toBe(true);
  });

  it("clicks only with approval when the page reads consequential, and sends the page's own check", async () => {
    const page = shop();
    const { ab } = browserFor(page);
    await expect(ab.call("click", { ref: "po" })).rejects.toThrow(
      /reads this click as "purchase".*Nothing was clicked/,
    );
    expect(page.done).toEqual([]);
    await ab.call("click", { ref: "po", approved: true });
    expect(page.done).toEqual(["click Place order (approved)"]);
    await ab.call("click", { ref: "more" });
    expect(page.done.at(-1)).toBe("click Show more");
  });

  it("asks before signing in, and refuses a click when the page changed after the approval", async () => {
    const page = shop();
    const { ab } = browserFor(page);
    await expect(ab.call("click", { ref: "si" })).rejects.toThrow(/account-or-settings/);
    expect(approvalKind({ name: "Continue with Google", role: "button", consequential: null }, null)).toBe(
      "account-or-settings",
    );
    // Approved, but the page moves on before the click: our own reading must match.
    const original = page.tab();
    let n = 0;
    const drifting: AgentTab = {
      ...original,
      call: async (m, p) => {
        if (m === "agent.describe") page.drift = n++;
        return original.call(m, p);
      },
    };
    const ab2 = new AgentBrowser({ tab: async () => drifting, internalOrigins: () => [] });
    await expect(ab2.call("click", { ref: "si", approved: true })).rejects.toThrow(/page changed/);
    expect(page.done).toEqual([]);
  });

  it("only reads on sensitive sites: every click needs approval, and it never types or chooses there", async () => {
    const page = new FakePage("https://www.chase.com/accounts", [
      { ref: "s", role: "link", name: "Statements" },
      { ref: "f", role: "textbox", name: "Search" },
    ]);
    const { ab } = browserFor(page);
    await expect(ab.call("click", { ref: "s" })).rejects.toThrow(/account-or-settings/);
    await expect(ab.call("type", { ref: "f", text: "rent" })).rejects.toThrow(/only reads/);
    await expect(ab.call("select", { ref: "f", option: "x" })).rejects.toThrow(/only reads/);
    expect(page.done).toEqual([]);
    await ab.call("click", { ref: "s", approved: true });
    expect(page.done).toEqual(["click Statements"]);
    expect(approvalKind({ name: "Book", role: "button", consequential: null }, "health")).toBe("submit");
  });

  it("stops at a robot check and asks for a helper", async () => {
    const page = shop();
    page.captcha = true;
    const { ab, helper } = browserFor(page);
    await expect(ab.call("click", { ref: "more" })).rejects.toThrow(/robot check/);
    await expect(ab.call("type", { ref: "n1", text: "hi" })).rejects.toThrow(/robot check/);
    expect(helper).toHaveLength(2);
    expect(page.done).toEqual([]);
  });

  it("opens web pages only, never files or AGENCY's own services", async () => {
    const page = shop();
    const { ab } = browserFor(page, ["http://127.0.0.1:8765"]);
    await expect(ab.call("navigate", { url: "file:///etc/passwd" })).rejects.toThrow(/Files/);
    await expect(ab.call("navigate", { url: "http://localhost:8765/api/lifeline/status" })).rejects.toThrow(
      /part of AGENCY/,
    );
    await expect(ab.call("navigate", { url: "javascript:alert(1)" })).rejects.toThrow();
    await ab.call("navigate", { url: "https://pharmacy.example/" });
    expect(page.done).toEqual(["open https://pharmacy.example/"]);
  });

  it("does nothing at all after Stop, until the person starts a new task", async () => {
    const page = shop();
    const { ab } = browserFor(page);
    ab.stop();
    for (const m of ["snapshot", "click", "type", "navigate", "select"])
      await expect(
        ab.call(m, { ref: "more", text: "x", url: "https://a.example", option: "x" }),
      ).rejects.toThrow(/pressed Stop/);
    ab.newTask();
    await ab.call("click", { ref: "more" });
    expect(page.done).toEqual(["click Show more"]);
  });
});

// ------------------------------------------------------------------------------------------------------------
// Under the agent's own runtime and guard

const REV = { risk: "reversible", kind: "none", summary: "", amount: 0 };

/** The agent's BrowserBridge over AgentBrowser, as utility.ts bridgeOverRpc + app.ts agentRpc wire it. */
function bridgeOver(ab: AgentBrowser): BrowserBridge {
  return {
    snapshot: () => ab.call("snapshot", {}) as Promise<PageSnapshot>,
    click: (ref, o) => ab.call("click", { ref, approved: o?.approved === true }) as Promise<BridgeResult>,
    type: (ref, text) => ab.call("type", { ref, text }) as Promise<BridgeResult>,
    navigate: (url) => ab.call("navigate", { url }) as Promise<BridgeResult>,
    select: (ref, option) => ab.call("select", { ref, option }) as Promise<BridgeResult>,
  };
}

async function run(
  page: FakePage,
  turns: ScriptTurn[],
  settings: Partial<SafetySettings>,
  decide = "approve",
) {
  const { ab } = browserFor(page);
  const s: SafetySettings = { ...DEFAULT_SETTINGS, ...settings };
  const model = new ScriptedModel(turns);
  const rt = new AgentRuntime({
    model,
    bridge: bridgeOver(ab),
    native: null,
    memory: null,
    packs: [],
    settings: () => s,
    computerUse: false,
  });
  const events: AgentEvent[] = [];
  rt.onEvent((e) => {
    events.push(e);
    if (e.type === "approval.required")
      queueMicrotask(
        () =>
          void rt.handle({
            type: "approval.decide",
            taskId: "web",
            decision: {
              approvalId: e.approval.id,
              fingerprint: e.approval.fingerprint,
              decision: decide as "approve",
            },
          }),
      );
  });
  await rt.handle({
    type: "task.start",
    request: { id: "web", goal: "Buy it", origin: "flow", dryRun: false },
  });
  return { events, model };
}

const plan = { name: "show_plan", args: { steps: [{ title: "Buy", risk: "consequential" }] } };

describe("the agent's guard, unchanged, over AGENCY Browser", () => {
  const real = { simulatedOnly: false, siteAllowlist: ["https://*"] };

  it("a purchase runs only after the person's approval of the exact total", async () => {
    const page = shop();
    const { events } = await run(
      page,
      [
        [plan],
        [{ name: "read_page", args: {} }],
        [{ name: "click_element", args: { ref: "po", ...REV } }],
        [{ name: "finish", args: { outcome: "Ordered", expect_text: "Order confirmed" } }],
      ],
      real,
    );
    const a = events.find((e) => e.type === "approval.required");
    expect(a?.type === "approval.required" && a.approval).toMatchObject({
      kind: "purchase",
      simulated: false,
    });
    expect(a?.type === "approval.required" && a.approval.details.Total).toBe("$12.00");
    expect(page.done).toEqual(["click Place order (approved)"]);
    expect(events.at(-1)).toMatchObject({ type: "task.done", verified: true });
  });

  it("declined: nothing is clicked", async () => {
    const page = shop();
    await run(
      page,
      [
        [plan],
        [{ name: "click_element", args: { ref: "po", ...REV } }],
        [{ name: "give_up", args: { reason: "Declined" } }],
      ],
      real,
      "decline",
    );
    expect(page.done).toEqual([]);
  });

  it("practice mode: a real purchase is refused before anyone is asked", async () => {
    const page = shop();
    const { events } = await run(
      page,
      [
        [plan],
        [{ name: "click_element", args: { ref: "po", ...REV } }],
        [{ name: "give_up", args: { reason: "Can't" } }],
      ],
      { siteAllowlist: ["https://*"] },
    );
    expect(events.some((e) => e.type === "approval.required")).toBe(false);
    expect(page.done).toEqual([]);
  });

  it("never types a password, a card number or a code", async () => {
    const page = shop();
    const { model } = await run(
      page,
      [
        [plan],
        [
          { name: "type_text", args: { ref: "pw", text: "hunter2", ...REV } },
          { name: "type_text", args: { ref: "n1", text: "card 4242 4242 4242 4242", ...REV } },
          { name: "type_text", args: { ref: "n1", text: "Leave it at the door", ...REV } },
        ],
        [{ name: "give_up", args: { reason: "Done" } }],
      ],
      real,
    );
    expect(page.done).toEqual(["type Note for the driver: Leave it at the door"]);
    expect(JSON.stringify(model.inputs)).not.toContain("hunter2");
  });

  it("a sign-in click the model called harmless still needs the person's approval", async () => {
    const page = shop();
    const { model } = await run(
      page,
      [
        [plan],
        [{ name: "click_element", args: { ref: "si", ...REV } }],
        [{ name: "give_up", args: { reason: "Needs a helper" } }],
      ],
      real,
    );
    expect(page.done).toEqual([]);
    expect(JSON.stringify(model.inputs)).toMatch(/account-or-settings/);
  });

  it("sites outside the caregiver's list stay off limits, even for AGENCY Browser", async () => {
    const page = shop();
    await run(
      page,
      [
        [plan],
        [{ name: "open_url", args: { url: "https://elsewhere.example/" } }],
        [{ name: "give_up", args: { reason: "No" } }],
      ],
      { siteAllowlist: ["https://shop.example"], simulatedOnly: false },
    );
    expect(page.done).toEqual([]);
  });
});
