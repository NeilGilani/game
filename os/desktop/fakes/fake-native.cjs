#!/usr/bin/env node
/**
 * Fake agency-native: newline-delimited JSON-RPC 2.0 over stdio implementing NativeMethods
 * (os/contracts/src/native.ts) with no effects on the Mac. For development and tests.
 *
 *   AGENCY_FAKE_NATIVE_LOG=<file>   append every call as a JSON line (tests read it)
 *   AGENCY_FAKE_NATIVE_HANG=<method> never answer that method (tests the host's timeouts)
 */
"use strict";

const fs = require("node:fs");
const readline = require("node:readline");

const logFile = process.env.AGENCY_FAKE_NATIVE_LOG || "";
const hang = process.env.AGENCY_FAKE_NATIVE_HANG || "";
let stopped = 0;

function record(entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    // ignore
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

const app = { bundleId: "com.example.fake", name: "Fake App", path: "/Applications/Fake.app", running: true, frontmost: true };
const permissions = {
  camera: "granted",
  accessibility: "granted",
  "screen-recording": "not-determined",
  microphone: "not-determined",
  "speech-recognition": "not-determined",
};

const methods = {
  "permissions.status": () => permissions,
  "permissions.request": ({ kind }) => ({ ...permissions, [kind]: "granted" }),
  "ax.targets": () => ({
    t: Date.now(),
    owner: app.bundleId,
    truncated: false,
    targets: [
      { id: "fake.ok", rect: { x: 400, y: 400, width: 160, height: 120 }, role: "button", label: "OK", source: "ax", owner: app.bundleId },
      { id: "fake.cancel", rect: { x: 600, y: 400, width: 160, height: 120 }, role: "button", label: "Cancel", source: "ax", owner: app.bundleId },
    ],
  }),
  "ax.press": ({ targetId }) => ({ ok: typeof targetId === "string" && targetId.startsWith("fake.") }),
  "input.click": () => ({ ok: true }),
  "input.scroll": () => ({ ok: true }),
  "input.type": () => ({ ok: true }),
  "input.key": () => ({ ok: true }),
  "apps.list": () => ({ apps: [app] }),
  "apps.launch": () => ({ ok: true }),
  "apps.activate": () => ({ ok: true }),
  "apps.frontmost": () => ({ app }),
  "screen.capture": () => ({ data: "", width: 0, height: 0, scale: 1, format: "png" }),
  "speech.say": () => ({ ok: true }),
  "speech.voices": () => ({ voices: [{ id: "fake.voice", name: "Fake Voice", personal: false }] }),
  "speech.listen": () => ({ ok: true }),
  "input.stopAll": () => {
    stopped += 1;
    return { ok: true };
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  record({ method: msg.method, params: msg.params });
  if (msg.method === hang) return;
  const fn = methods[msg.method];
  if (!fn) {
    send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    return;
  }
  try {
    send({ id: msg.id, result: fn(msg.params || {}) });
  } catch (err) {
    send({ id: msg.id, error: { code: -32000, message: String(err && err.message) } });
  }
});
rl.on("close", () => process.exit(0));

// A frontmost-changed event shortly after start, so hosts can test event plumbing.
setTimeout(() => send({ method: "event", params: { type: "frontmost-changed", app } }), 200);
process.stderr.write(`fake agency-native ready (pid ${process.pid})\n`);
module.exports = { stoppedCount: () => stopped };
