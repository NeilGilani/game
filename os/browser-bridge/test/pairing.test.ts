/**
 * Protocol and pairing: the real BridgeServer and the real host relay (in-process, over a real Unix
 * socket), with a simulated extension speaking Chrome's native messaging frames. Chrome itself is covered
 * by the Playwright suite; this checks the security properties directly.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeCallError, BridgeServer } from "../src/app/server.ts";
import { ensurePairing } from "../src/app/install.ts";
import { SignedChannel, hmac, hmacKey, hmacVerify, randomHex, readyText, welcomeText } from "../src/auth.ts";
import { FrameDecoder, encodeFrame } from "../src/host/framing.ts";
import { hostAuthMac, originAllowed, runHost } from "../src/host/host.ts";
import type { BridgeRequest, BridgeResponse } from "../src/protocol.ts";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const until = async (fn: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A pretend extension: talks frames to the host, pairs, handshakes and answers commands. */
class FakeExtension {
  stdin = new PassThrough();
  stdout = new PassThrough();
  received: Array<Record<string, unknown>> = [];
  token: string | null = null;
  channel: SignedChannel | null = null;
  commands: BridgeRequest[] = [];
  dropped = 0;
  private pending: { extNonce: string } | null = null;
  private decoder = new FrameDecoder();

  constructor(private readonly tokenOverride?: string) {
    this.stdout.on("data", (c: Buffer) => {
      for (const m of this.decoder.push(c) as Array<Record<string, unknown>>) void this.onMessage(m);
    });
  }

  send(m: unknown): void {
    this.stdin.write(encodeFrame(m));
  }

  private async onMessage(m: Record<string, unknown>): Promise<void> {
    this.received.push(m);
    if (m.k === "host.pairing") this.token ??= this.tokenOverride ?? (m.token as string);
    if (m.k === "host.status" && m.agency === "connected") {
      // Like the real extension: without a token, ask for one; the host answers and says connected again.
      if (!this.token) {
        this.send({ k: "pair.request" });
        return;
      }
      const extNonce = randomHex(16);
      this.pending = { extNonce };
      this.send({ k: "hello", extNonce, protocol: 1, extensionVersion: "test" });
    }
    const pending = this.pending;
    if (m.k === "welcome" && pending && this.token && m.extNonce === pending.extNonce) {
      const key = await hmacKey(this.token);
      if (!(await hmacVerify(key, welcomeText(pending.extNonce, m.appNonce as string), m.mac as string)))
        return;
      const session = `${pending.extNonce}.${m.appNonce as string}`;
      this.channel = new SignedChannel(key, session, ["res", "evt"]);
      this.send({ k: "ready", extNonce: pending.extNonce, mac: await hmac(key, readyText(session)) });
    }
    if (m.k === "cmd" && this.channel) {
      const req = (await this.channel.open(m as never)) as BridgeRequest | null;
      if (!req) {
        this.dropped++;
        return;
      }
      this.commands.push(req);
      const res: BridgeResponse = { id: req.id, ok: true, result: { echo: req.method } };
      this.send(await this.channel.seal("res", res));
    }
  }
}

describe("pairing and the signed protocol", () => {
  let dir: string;
  let server: BridgeServer;
  let token: string;
  let socketPath: string;
  const hosts: Array<{ close: () => void }> = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "agbt-"));
    const cfg = ensurePairing({ dir, extensionIds: [EXT] });
    token = cfg.token;
    socketPath = cfg.socketPath;
    server = new BridgeServer({ socketPath, token });
    await server.start();
  });
  afterEach(async () => {
    for (const h of hosts.splice(0)) h.close();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function startHost(ext: FakeExtension, origin = `chrome-extension://${EXT}/`) {
    const exits: number[] = [];
    const h = runHost({ socketPath, token, extensionIds: [EXT] }, origin, {
      stdin: ext.stdin,
      stdout: ext.stdout,
      log: () => undefined,
      exit: (c) => exits.push(c),
      retryMs: 50,
    });
    hosts.push(h);
    return exits;
  }

  it("keeps the pairing file and socket private to the person's account", () => {
    expect(statSync(join(dir, "bridge.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("pairs on first use and carries signed commands both ways", async () => {
    const ext = new FakeExtension();
    startHost(ext);
    await server.waitUntilReady(15_000);
    expect(ext.token).toBe(token);
    const r = await server.call("bridge.status", {});
    expect(r).toEqual({ echo: "bridge.status" });
  });

  it("only serves the AGENCY Bridge extension", () => {
    expect(originAllowed(`chrome-extension://${EXT}/`, [EXT])).toBe(true);
    expect(originAllowed("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/", [EXT])).toBe(false);
    expect(originAllowed(null, [EXT])).toBe(false);
    const ext = new FakeExtension();
    const exits = startHost(ext, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/");
    expect(exits).toEqual([1]);
  });

  it("refuses socket clients that don't know the token", async () => {
    const s = connect(socketPath);
    const lines: string[] = [];
    s.on("data", (d) => lines.push(...d.toString().split("\n").filter(Boolean)));
    await until(() => lines.length > 0);
    s.write(JSON.stringify({ t: "auth", mac: hostAuthMac(randomBytes(32).toString("hex"), "wrong") }) + "\n");
    await new Promise<void>((r) => s.on("close", () => r()));
    expect(server.connection).toBe("no-host");
  });

  it("an extension with a different token can't complete the handshake, so nothing is sent to it", async () => {
    const ext = new FakeExtension(randomBytes(32).toString("hex"));
    startHost(ext);
    await until(() => ext.received.some((m) => m.k === "welcome"));
    await new Promise((r) => setTimeout(r, 100));
    expect(ext.channel).toBeNull();
    expect(server.connection).toBe("host-connected");
    await expect(server.call("bridge.status", {})).rejects.toBeInstanceOf(BridgeCallError);
  });

  it("drops forged, replayed and re-ordered commands", async () => {
    const ext = new FakeExtension();
    startHost(ext);
    await server.waitUntilReady(15_000);
    await server.call("bridge.status", {});
    const real = ext.received.filter((m) => m.k === "cmd");
    expect(real).toHaveLength(1);
    // Something on the Mac writes into the extension's stream: replay, forgery and a tampered body.
    const replay = real[0]!;
    const forged = {
      k: "cmd",
      seq: 99,
      body: JSON.stringify({ id: "x", method: "page.click", params: {} }),
      mac: "0".repeat(64),
    };
    const tampered = {
      ...replay,
      seq: 100,
      body: (replay.body as string).replace("bridge.status", "stop.all"),
    };
    for (const m of [replay, forged, tampered]) ext.stdout.write(encodeFrame(m));
    await until(() => ext.dropped === 3);
    expect(ext.commands.map((c) => c.method)).toEqual(["bridge.status"]);
  });

  it("drops responses that weren't signed by the extension", async () => {
    const ext = new FakeExtension();
    startHost(ext);
    await server.waitUntilReady(15_000);
    const p = server.call("tabs.list", {}, { timeoutMs: 300 });
    // A forged response arrives first; the real one follows from the extension.
    ext.stdin.write(
      encodeFrame({
        k: "res",
        seq: 50,
        body: JSON.stringify({ id: "1", ok: true, result: "forged" }),
        mac: "f".repeat(64),
      }),
    );
    expect(await p).toEqual({ echo: "tabs.list" });
  });

  it("reconnects when AGENCY restarts, with a fresh session", async () => {
    const ext = new FakeExtension();
    startHost(ext);
    await server.waitUntilReady(15_000);
    const firstSession = ext.channel?.session;
    await server.stop();
    server = new BridgeServer({ socketPath, token });
    await server.start();
    await server.waitUntilReady(15_000);
    expect(ext.channel?.session).not.toBe(firstSession);
    expect(await server.call("bridge.status", {})).toEqual({ echo: "bridge.status" });
  });

  it("fails pending calls plainly when Chrome goes away", async () => {
    const ext = new FakeExtension();
    // This extension never answers page.tree.
    startHost(ext);
    await server.waitUntilReady(15_000);
    ext.channel = null;
    const p = server.call("page.tree", { tabId: 1 });
    hosts.splice(0).forEach((h) => h.close());
    await expect(p).rejects.toMatchObject({ code: "not-paired" });
  });
});
