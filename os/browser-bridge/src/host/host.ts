/**
 * The native messaging host Chrome starts for the AGENCY Bridge extension. It is a relay:
 *   Chrome (stdin/stdout, length-prefixed JSON)  <->  AGENCY (Unix socket, newline-delimited JSON).
 * It can't forge commands: AGENCY and the extension sign everything end to end. Its jobs are to prove to
 * AGENCY that it was installed by AGENCY (it knows the token), to hand the token to the extension on first
 * pairing, and to keep reconnecting while AGENCY isn't running.
 *
 * Usage (written by the installer): agency-bridge-host --config <bridge.json> chrome-extension://<id>/
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { FrameDecoder, LineDecoder, MAX_TO_CHROME, encodeFrame } from "./framing.ts";

export interface HostConfig {
  socketPath: string;
  token: string;
  extensionIds: string[];
}

export function parseArgs(argv: string[]): { configPath: string; origin: string | null } {
  const i = argv.indexOf("--config");
  const configPath = i >= 0 ? argv[i + 1] : undefined;
  if (!configPath) throw new Error("Missing --config <path>.");
  const origin = argv.find((a) => a.startsWith("chrome-extension://")) ?? null;
  return { configPath, origin };
}

export function originAllowed(origin: string | null, ids: string[]): boolean {
  if (!origin) return false;
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin);
  return !!m && ids.includes(m[1] ?? "");
}

export const hostAuthMac = (token: string, nonce: string) =>
  createHmac("sha256", Buffer.from(token, "hex")).update(`host|${nonce}`).digest("hex");

export interface HostIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  log: (msg: string) => void;
  exit: (code: number) => void;
  connectSocket?: (path: string) => Socket;
  retryMs?: number;
}

export function runHost(config: HostConfig, origin: string | null, io: HostIO): { close: () => void } {
  const toChrome = (m: unknown) => {
    try {
      io.stdout.write(encodeFrame(m));
    } catch (e) {
      io.log(`dropped message to Chrome: ${(e as Error).message}`);
    }
  };

  if (!originAllowed(origin, config.extensionIds)) {
    io.log(`refusing caller ${origin ?? "(none)"}`);
    toChrome({ k: "host.error", message: "This host only serves the AGENCY Bridge extension." });
    io.exit(1);
    return { close: () => undefined };
  }

  let sock: Socket | null = null;
  let authed = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const retryMs = io.retryMs ?? 1000;

  const dial = () => {
    if (closed) return;
    const s = (io.connectSocket ?? ((p: string) => connect(p)))(config.socketPath);
    sock = s;
    authed = false;
    const lines = new LineDecoder();
    s.on("data", (chunk: Buffer) => {
      let ls: string[];
      try {
        ls = lines.push(chunk);
      } catch {
        s.destroy();
        return;
      }
      for (const line of ls) {
        let m: { t?: string; nonce?: string; k?: string };
        try {
          m = JSON.parse(line) as typeof m;
        } catch {
          continue;
        }
        if (!authed) {
          if (m.t === "challenge" && typeof m.nonce === "string") {
            s.write(JSON.stringify({ t: "auth", mac: hostAuthMac(config.token, m.nonce) }) + "\n");
          } else if (m.t === "ok") {
            authed = true;
            toChrome({ k: "host.status", agency: "connected" });
          }
          continue;
        }
        if (Buffer.byteLength(line) > MAX_TO_CHROME) {
          io.log("message from AGENCY too large for Chrome; dropped");
          continue;
        }
        // Signed wire traffic: relay unchanged.
        if (m.k === "welcome" || m.k === "cmd") toChrome(m);
      }
    });
    const lost = () => {
      if (sock !== s) return;
      sock = null;
      if (authed) toChrome({ k: "host.status", agency: "waiting" });
      authed = false;
      if (!closed) retry = setTimeout(dial, retryMs);
    };
    s.on("error", () => undefined);
    s.on("close", lost);
  };

  const frames = new FrameDecoder();
  io.stdin.on("data", (chunk: Buffer) => {
    let msgs: unknown[];
    try {
      msgs = frames.push(chunk);
    } catch (e) {
      io.log(`bad frame from Chrome: ${(e as Error).message}`);
      close();
      io.exit(1);
      return;
    }
    for (const raw of msgs) {
      const m = raw as { k?: string };
      if (m.k === "pair.request") {
        toChrome({ k: "host.pairing", token: config.token });
        if (authed) toChrome({ k: "host.status", agency: "connected" });
        continue;
      }
      if ((m.k === "hello" || m.k === "ready" || m.k === "res" || m.k === "evt") && sock && authed) {
        sock.write(JSON.stringify(m) + "\n");
      }
    }
  });

  const close = () => {
    closed = true;
    if (retry) clearTimeout(retry);
    sock?.destroy();
  };
  io.stdin.on("end", () => {
    close();
    io.exit(0);
  });

  toChrome({ k: "host.status", agency: "waiting" });
  dial();
  return { close };
}

export function main(): void {
  const log = (msg: string) => process.stderr.write(`[agency-bridge-host] ${msg}\n`);
  try {
    const { configPath, origin } = parseArgs(process.argv.slice(2));
    const config = JSON.parse(readFileSync(configPath, "utf8")) as HostConfig;
    runHost(config, origin, {
      stdin: process.stdin,
      stdout: process.stdout,
      log,
      exit: (c) => process.exit(c),
    });
  } catch (e) {
    log((e as Error).message);
    process.exit(1);
  }
}
