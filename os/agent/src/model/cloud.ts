/**
 * AGENCY Cloud for the agent: Gemini on AGENCY's key through AGENCY's relay (site/functions/_lib/relay.ts), used
 * when there is no GEMINI_API_KEY of your own. Default https://getagencyos.pages.dev; AGENCY_RELAY_URL changes it,
 * AGENCY_RELAY=off switches it off. No API key is in the app: the install secret below only signs requests to the
 * relay, which holds the key.
 *
 * - Identity: an anonymous install (random id, secret derived by the relay), registered on first use and kept in
 *   the macOS keychain (service "AGENCY", account "agency-cloud-install", shared with the coordinator), elsewhere
 *   in a 0600 file (AGENCY_CLOUD_IDENTITY_FILE, default ~/.agency/agency-cloud.json).
 * - Each turn is signed: HMAC-SHA256(secret, "AGENCY-CLOUD-1\nPOST\n/api/relay/v1/interactions\ntime\nsha256(body)").
 * - The request is the same stateless Interactions turn GeminiModel would send to Google (store:false); the relay
 *   checks it, forwards it and keeps none of it.
 * - The relay's refusals become plain words (busy, today's limit, switched off); Gemini's own errors keep their
 *   usual meaning.
 */

import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GeminiResponse, GeminiTransport } from "./gemini";
import { KEYCHAIN_SERVICE } from "./keys";
import { ModelUnavailable } from "./types";

export const DEFAULT_RELAY_URL = "https://getagencyos.pages.dev";
export const CLOUD_KEYCHAIN_ACCOUNT = "agency-cloud-install";
export const INTERACTIONS_PATH = "/api/relay/v1/interactions";
const REGISTER_PATH = "/api/relay/v1/register";

/** The relay's address, or null when AGENCY_RELAY switches AGENCY Cloud off. */
export function relayUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  if (["0", "off", "false", "no"].includes((env.AGENCY_RELAY ?? "").trim().toLowerCase())) return null;
  return (env.AGENCY_RELAY_URL?.trim() || DEFAULT_RELAY_URL).replace(/\/+$/, "") || null;
}

// ---------------------------------------------------------------------------------------------------------
// The install identity

export interface CloudIdentity {
  installId: string;
  secret: string;
  relay: string;
}

export interface IdentityStore {
  load(): Promise<CloudIdentity | null>;
  save(identity: CloudIdentity): Promise<void>;
}

function parseIdentity(text: string | null | undefined): CloudIdentity | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<CloudIdentity>;
    return typeof v.installId === "string" && typeof v.secret === "string" && typeof v.relay === "string"
      ? { installId: v.installId, secret: v.secret, relay: v.relay }
      : null;
  } catch {
    return null;
  }
}

export function memoryIdentityStore(initial: CloudIdentity | null = null): IdentityStore {
  let identity = initial;
  return {
    load: async () => identity,
    save: async (i) => {
      identity = i;
    },
  };
}

/** A small JSON file only this user can read. */
export function fileIdentityStore(path: string): IdentityStore {
  return {
    load: async () => parseIdentity(await readFile(path, "utf8").catch(() => null)),
    save: async (identity) => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(identity), { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}

export type SecurityRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const runSecurity: SecurityRunner = (args) =>
  new Promise((resolve) => {
    execFile("/usr/bin/security", args, { timeout: 5000 }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout ?? "") }),
    );
  });

/** The macOS keychain: the same item the coordinator reads, so one Mac is one install. */
export function keychainIdentityStore(run: SecurityRunner = runSecurity): IdentityStore {
  const base = ["-s", KEYCHAIN_SERVICE, "-a", CLOUD_KEYCHAIN_ACCOUNT];
  return {
    load: async () => {
      const r = await run(["find-generic-password", ...base, "-w"]);
      return r.ok ? parseIdentity(r.stdout.trim()) : null;
    },
    save: async (identity) => {
      const r = await run(["add-generic-password", ...base, "-w", JSON.stringify(identity), "-U"]);
      if (!r.ok) throw new Error("Couldn't save the AGENCY Cloud install in the keychain.");
    },
  };
}

export function defaultIdentityStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): IdentityStore {
  if (env.AGENCY_CLOUD_IDENTITY_FILE) return fileIdentityStore(env.AGENCY_CLOUD_IDENTITY_FILE);
  if (platform === "darwin") return keychainIdentityStore();
  return fileIdentityStore(join(homedir(), ".agency", "agency-cloud.json"));
}

// ---------------------------------------------------------------------------------------------------------
// Errors

/** The relay's own refusals, in the words the person sees. `retry`: worth trying again soon. */
export const PLAIN: Record<string, { text: string; retry: boolean }> = {
  busy: { text: "AGENCY's AI is busy. Try again in a minute.", retry: true },
  daily_limit: {
    text: "AGENCY's AI has reached today's limit for this computer. Try again tomorrow.",
    retry: false,
  },
  budget: { text: "AGENCY's AI has reached its daily limit. Try again tomorrow.", retry: false },
  disabled: { text: "AGENCY's AI is switched off for now.", retry: false },
  auth: { text: "AGENCY's AI couldn't confirm this computer. Try again later.", retry: true },
  clock: {
    text: "This computer's clock is wrong, so AGENCY's AI can't be used. Set the time automatically.",
    retry: false,
  },
  blocked: { text: "This computer can't use AGENCY's AI.", retry: false },
  too_large: { text: "This step was too large for AGENCY's AI.", retry: false },
  bad_request: { text: "AGENCY's AI couldn't take this step.", retry: false },
  upstream_key: { text: "AGENCY's AI isn't available right now.", retry: true },
  upstream_timeout: { text: "AGENCY's AI didn't answer in time.", retry: true },
};

/** Gemini's own error, passed on by the relay: GeminiModel reads `status` as it does from Google. */
export class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RelayErrorBody {
  error?: { reason?: string; message?: string; serverTime?: number };
}

// ---------------------------------------------------------------------------------------------------------
// The client

export function signature(secret: string, method: string, path: string, time: number, body: string): string {
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = ["AGENCY-CLOUD-1", method.toUpperCase(), path, String(time), hash].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export interface AgencyCloudOptions {
  baseUrl: string;
  store: IdentityStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Wait before the one retry of a turn that failed for a passing reason (tests use 0). */
  retryDelayMs?: number;
}

export class AgencyCloud {
  readonly baseUrl: string;
  private readonly store: IdentityStore;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private identity: CloudIdentity | null = null;
  private clockOffsetS = 0;

  constructor(opts: AgencyCloudOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.store = opts.store;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.now = opts.now ?? Date.now;
    this.retryDelayMs = opts.retryDelayMs ?? 800;
  }

  private async register(signal: AbortSignal): Promise<CloudIdentity> {
    const res = await this.fetchFn(this.baseUrl + REGISTER_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) throw await this.failure(res);
    const data = (await res.json().catch(() => null)) as Partial<CloudIdentity> | null;
    if (typeof data?.installId !== "string" || typeof data.secret !== "string")
      throw new ModelUnavailable("AGENCY's AI gave an answer AGENCY couldn't read.", true);
    const identity = { installId: data.installId, secret: data.secret, relay: this.baseUrl };
    await this.store.save(identity).catch(() => undefined); // kept for this session if it can't be saved
    return identity;
  }

  private async who(signal: AbortSignal, renew: boolean): Promise<CloudIdentity> {
    if (!renew) {
      if (this.identity?.relay === this.baseUrl) return this.identity;
      const stored = await this.store.load().catch(() => null);
      if (stored?.relay === this.baseUrl) return (this.identity = stored);
    }
    return (this.identity = await this.register(signal));
  }

  private async failure(res: Response): Promise<Error> {
    const body = (await res.json().catch(() => null)) as RelayErrorBody | null;
    const reason = body?.error?.reason ?? "";
    const plain = PLAIN[reason];
    if (plain) return Object.assign(new ModelUnavailable(plain.text, plain.retry), { reason, body });
    return new RelayHttpError(
      res.status,
      (body?.error?.message ?? `AGENCY's AI answered ${res.status}.`).slice(0, 300),
    );
  }

  /** One signed request. Re-registers once if the relay doesn't know this computer, fixes the clock once. */
  async post(path: string, payload: unknown, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const body = JSON.stringify(payload);
    const url = new URL(this.baseUrl + path);
    let renew = false;
    let clockFixed = false;
    let retried = false;
    for (;;) {
      let res: Response;
      try {
        const who = await this.who(signal, renew);
        const time = Math.floor(this.now() / 1000 + this.clockOffsetS);
        res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agency-install": who.installId,
            "x-agency-time": String(time),
            "x-agency-signature": signature(who.secret, "POST", url.pathname, time, body),
          },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (e) {
        if (signal.aborted) throw e; // the person pressed Stop
        if (e instanceof ModelUnavailable || e instanceof RelayHttpError) throw e;
        const timedOut = e instanceof Error && e.name === "TimeoutError";
        if (!timedOut && !retried) {
          retried = true;
          await this.pause(signal);
          continue;
        }
        throw new ModelUnavailable(
          timedOut ? PLAIN.upstream_timeout!.text : "Can't reach AGENCY's AI (no connection).",
          true,
        );
      }
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as unknown;
        if (!data || typeof data !== "object")
          throw new ModelUnavailable("AGENCY's AI gave an answer AGENCY couldn't read.", true);
        return data;
      }
      const err = await this.failure(res);
      const reason = (err as { reason?: string }).reason;
      if (reason === "auth" && !renew) {
        renew = true; // the server secret was rotated, or the stored install is from another relay
        continue;
      }
      const serverTime = (err as { body?: RelayErrorBody }).body?.error?.serverTime;
      if (reason === "clock" && typeof serverTime === "number" && !clockFixed) {
        this.clockOffsetS = serverTime - this.now() / 1000;
        clockFixed = true;
        continue;
      }
      if (err instanceof RelayHttpError && err.status >= 500 && !retried) {
        retried = true; // Gemini had a moment: once more, then the person hears about it
        await this.pause(signal);
        continue;
      }
      throw err;
    }
  }

  private pause(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, this.retryDelayMs);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}

/** GeminiModel's transport through AGENCY Cloud. */
export function cloudTransport(cloud: AgencyCloud, timeoutMs = 120_000): GeminiTransport {
  return async (request, signal) =>
    (await cloud.post(INTERACTIONS_PATH, request, signal, timeoutMs)) as GeminiResponse;
}
