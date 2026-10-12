import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCommand, AgentEvent } from "../src/state/contracts";
import { connect } from "../src/state/agent";

/** The Mac app's host as the shell sees it: the real agent and main's Stop broadcast. */
function macHost() {
  const sentToMac: AgentCommand[] = [];
  const stopListeners: (() => void)[] = [];
  let stopAllCalls = 0;
  const agency = {
    role: "shell",
    agent: { send: (c: AgentCommand) => sentToMac.push(c), onEvent: () => () => {} },
    native: { call: async () => ({ ok: true }) },
    stopAll: async () => {
      stopAllCalls += 1;
    },
    onStopAll: (l: () => void) => {
      stopListeners.push(l);
      return () => stopListeners.splice(stopListeners.indexOf(l), 1);
    },
  };
  vi.stubGlobal("window", { agency });
  return {
    sentToMac,
    stopListeners,
    stopAllCalls: () => stopAllCalls,
    /** Main tells every window that Stop happened (from the overlay, the hotkey, the menu or Chrome). */
    broadcastStop: () => [...stopListeners].forEach((l) => l()),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Stop in the Mac app reaches the practice tasks too", () => {
  it("a Stop from the overlay (main's broadcast) stops practice tasks once, and nothing is echoed to main", async () => {
    const mac = macHost();
    const link = connect();
    expect(link.simulated).toBe(false);
    const events: AgentEvent[] = [];
    link.onEvent((e) => events.push(e));
    const unfollow = link.followHostStop!();
    link.send({
      type: "task.start",
      request: { id: "food-1", goal: "Order pad thai", origin: "flow", selections: { kind: "food" } },
    });
    link.send({ type: "task.start", request: { id: "mac-1", goal: "Open Music", origin: "flow" } });
    // Practice tasks stay in the page; the rest go to the Mac agent.
    expect(mac.sentToMac.map((c) => c.type)).toEqual(["task.start"]);

    mac.broadcastStop();
    mac.broadcastStop(); // a second broadcast (e.g. Stop pressed twice) stops nothing more
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "task.stopped" && e.taskId === "food-1")).toBe(true),
    );
    expect(events.filter((e) => e.type === "task.stopped" && e.taskId === "food-1")).toHaveLength(1);
    // A broadcast is state, never a command: nothing goes back to main.
    expect(mac.sentToMac.filter((c) => c.type === "stop.all")).toHaveLength(0);
    expect(mac.stopAllCalls()).toBe(0);

    unfollow();
    expect(mac.stopListeners).toHaveLength(0);
  });
});
