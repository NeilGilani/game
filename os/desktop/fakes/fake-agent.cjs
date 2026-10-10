/**
 * Fake agent for the Electron utility process (HostToAgent / AgentToHost in os/contracts/src/host.ts, which is
 * os/agent's protocol). os/agent ships the real FakeAgent (AGENCY_AGENT_FAKE=1); this one exists so the desktop
 * tests don't depend on another package. Walks a scripted,
 * simulated task so the shell and overlay can be developed and tested without os/agent. It never acts on the Mac.
 *
 *   AGENCY_FAKE_AGENT_LOG=<file>   append every command received as a JSON line (tests read it)
 */
"use strict";

const fs = require("node:fs");

const port = process.parentPort;
const logFile = process.env.AGENCY_FAKE_AGENT_LOG || "";
const timers = new Set();

function record(entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    // ignore
  }
}

function emit(event) {
  port.postMessage({ kind: "event", event });
}

function later(ms, fn) {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}

const tasks = new Map();
let rpcId = 0;

function start(request) {
  const taskId = request.id;
  tasks.set(taskId, { stopped: false });
  emit({ type: "task.started", taskId, goal: request.goal, dryRun: true });
  emit({
    type: "task.plan",
    taskId,
    steps: [
      { id: "s1", title: "Open the sandbox store", risk: "read", status: "pending" },
      { id: "s2", title: "Choose the meal", risk: "reversible", status: "pending" },
      { id: "s3", title: "Pay (simulated)", risk: "consequential", status: "pending" },
    ],
  });
  later(300, () => {
    if (tasks.get(taskId)?.stopped) return;
    emit({ type: "task.step", taskId, stepId: "s1", status: "done", summary: "Opened the sandbox store (simulated)." });
    emit({
      type: "approval.required",
      taskId,
      approval: {
        id: `${taskId}.pay`,
        kind: "purchase",
        summary: "Pay $24.80 to Thai Basil for 1 pad thai (mild). Simulated.",
        details: { amount: "$24.80", to: "Thai Basil" },
        fingerprint: "fake-fingerprint",
        simulated: true,
      },
    });
  });
}

port.postMessage({ kind: "status", status: { fake: true, note: "Desktop test fake agent." } });

port.on("message", (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.kind === "ping") {
    port.postMessage({ kind: "pong", id: msg.id });
    return;
  }
  if (msg.kind === "rpc.result") {
    record({ rpcResult: msg });
    return;
  }
  if (msg.kind !== "command") return;
  const cmd = msg.command;
  record({ command: cmd });
  switch (cmd.type) {
    case "task.start":
      start(cmd.request);
      break;
    case "approval.decide":
      if (cmd.decision.decision === "approve" && cmd.decision.fingerprint === "fake-fingerprint") {
        emit({ type: "task.done", taskId: cmd.taskId, outcome: "Ordered (simulated).", verified: true });
      } else {
        emit({ type: "task.stopped", taskId: cmd.taskId, by: "person" });
      }
      break;
    case "task.stop":
      tasks.set(cmd.taskId, { stopped: true });
      emit({ type: "task.stopped", taskId: cmd.taskId, by: "person" });
      break;
    case "stop.all":
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const [taskId, state] of tasks) {
        if (!state.stopped) emit({ type: "task.stopped", taskId, by: "person" });
        state.stopped = true;
      }
      port.postMessage({ kind: "log", level: "info", message: "stop.all received" });
      // Like the real agent: also ask main to stop synthetic input (Stop must not depend on this).
      port.postMessage({ kind: "rpc", id: ++rpcId, target: "native", method: "input.stopAll", params: {} });
      break;
    default:
      break;
  }
});
