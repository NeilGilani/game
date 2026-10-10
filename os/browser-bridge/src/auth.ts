/**
 * End-to-end authentication between AGENCY and the extension, with Web Crypto (works in Node 20+ and in
 * the extension's service worker).
 *
 * Handshake (the host relays it, but can't forge it without the token):
 *   ext -> app  hello   { extNonce }
 *   app -> ext  welcome { appNonce, mac = HMAC(token, "welcome|" + extNonce + "|" + appNonce) }
 *   ext -> app  ready   { mac = HMAC(token, "ready|" + session) }        session = extNonce + "." + appNonce
 * Then every message is { seq, body, mac = HMAC(token, dir + "|" + session + "|" + seq + "|" + body) } with
 * seq strictly increasing per direction, so messages can't be replayed, reordered or moved between
 * sessions or directions.
 */

export type Direction = "cmd" | "res" | "evt";

const enc = new TextEncoder();

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function hmacKey(tokenHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/.test(tokenHex)) throw new Error("The pairing token must be 32 bytes of hex.");
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(tokenHex.slice(i * 2, i * 2 + 2), 16);
  return globalThis.crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmac(key: CryptoKey, text: string): Promise<string> {
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(text));
  return toHex(new Uint8Array(sig));
}

/** Constant-time comparison through HMAC verify, so timing reveals nothing about the expected MAC. */
export async function hmacVerify(key: CryptoKey, text: string, macHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(macHex)) return false;
  const sig = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sig[i] = parseInt(macHex.slice(i * 2, i * 2 + 2), 16);
  return globalThis.crypto.subtle.verify("HMAC", key, sig, enc.encode(text));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(text));
  return toHex(new Uint8Array(d));
}

/** A short, human-checkable fingerprint of the token (never the token itself). */
export async function tokenFingerprint(tokenHex: string): Promise<string> {
  const h = await sha256Hex("agency-bridge-pairing|" + tokenHex);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`.toUpperCase();
}

export const welcomeText = (extNonce: string, appNonce: string) => `welcome|${extNonce}|${appNonce}`;
export const readyText = (session: string) => `ready|${session}`;
export const signedText = (dir: Direction, session: string, seq: number, body: string) =>
  `${dir}|${session}|${seq}|${body}`;

/** One side of an authenticated session: signs what it sends and checks what it receives. */
export class SignedChannel {
  private sendSeq = 0;
  private recvSeq = 0;

  constructor(
    private readonly key: CryptoKey,
    readonly session: string,
    private readonly sendDirs: readonly Direction[],
  ) {}

  async seal(
    dir: Direction,
    payload: unknown,
  ): Promise<{ k: Direction; seq: number; body: string; mac: string }> {
    if (!this.sendDirs.includes(dir)) throw new Error(`This side can't send ${dir}.`);
    const body = JSON.stringify(payload);
    const seq = ++this.sendSeq;
    return { k: dir, seq, body, mac: await hmac(this.key, signedText(dir, this.session, seq, body)) };
  }

  /** Returns the payload, or null if the message is forged, replayed, out of order or the wrong direction. */
  async open(msg: { k: Direction; seq: number; body: string; mac: string }): Promise<unknown | null> {
    if (this.sendDirs.includes(msg.k)) return null;
    if (!Number.isSafeInteger(msg.seq) || msg.seq <= this.recvSeq) return null;
    if (typeof msg.body !== "string" || typeof msg.mac !== "string") return null;
    if (!(await hmacVerify(this.key, signedText(msg.k, this.session, msg.seq, msg.body), msg.mac)))
      return null;
    this.recvSeq = msg.seq;
    try {
      return JSON.parse(msg.body) as unknown;
    } catch {
      return null;
    }
  }
}
