/**
 * AGENCY Cloud: the relay the Mac app's coordinator and agent call instead of Google, so nobody needs a key of their
 * own. It runs on the site's own Gemini key (the GEMINI_API_KEY Pages secret). See docs/AI_RELAY.md.
 *
 *   POST /api/relay/v1/register      -> { installId, secret }        a new anonymous install (no account, no data)
 *   GET  /api/relay/v1/status        (signed) -> { ok, models, limits }
 *   POST /api/relay/v1/generate      (signed) one JSON-mode answer (plans, replies, explanations)
 *   POST /api/relay/v1/interactions  (signed) one turn of the computer-use agent (text, function calls, screenshots)
 *
 * Not a general Gemini proxy: two request shapes only, allow-listed models, every field checked (unknown fields are
 * refused), size, token and screenshot caps, and the settings that matter forced here (JSON output and safety
 * thresholds for answers; store:false, prompt-injection detection and no server-side tools for the agent).
 *
 * Identity: the install id is random. Its secret is HMAC(RELAY_SIGNING_SECRET, id), so the relay stores nothing to
 * check a signature, and rotating RELAY_SIGNING_SECRET retires every install at once (apps re-register by themselves).
 * Each request is signed: HMAC-SHA256(secret, "AGENCY-CLOUD-1\nMETHOD\n/path\nunix-time\nsha256(body)").
 *
 * Cost and abuse: per install and per network (IP) limits a minute and a day, a global daily cap, and a kill switch
 * (RELAY_ENABLED=0). Counters live in D1 when the RELAY_DB binding exists (atomic and shared by every Cloudflare
 * location), otherwise in this isolate's memory (best effort). Networks are counted under a keyed hash, never the
 * address itself.
 *
 * Privacy: request content (prompts, screenshots, document text) is never logged or stored: only counters. The few
 * log lines here carry a status code or a reason word and nothing else.
 */
import { clean } from "./gemini";

// ------------------------------------------------------------------------------------------------------------
// Bindings and settings

/** The part of Cloudflare's D1 binding this file uses (so no extra type package is needed). */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ results?: unknown[] }[]>;
}

export interface RelayEnv {
  GEMINI_API_KEY?: string;
  /** At least 32 characters; the relay is off without it. */
  RELAY_SIGNING_SECRET?: string;
  /** "0", "false", "off" or "no" switches AGENCY Cloud off at once (apps fall back to their built-in plans). */
  RELAY_ENABLED?: string;
  RELAY_DAILY_REQUEST_CAP?: string;
  RELAY_INSTALL_PER_MINUTE?: string;
  RELAY_INSTALL_PER_DAY?: string;
  RELAY_IP_PER_MINUTE?: string;
  RELAY_IP_PER_DAY?: string;
  RELAY_REGISTER_PER_IP_DAY?: string;
  RELAY_REGISTER_DAILY_CAP?: string;
  /** Comma-separated install ids to refuse. */
  RELAY_BLOCKED_INSTALLS?: string;
  /** Comma-separated model allow-lists (defaults below). */
  RELAY_GENERATE_MODELS?: string;
  RELAY_AGENT_MODELS?: string;
  RELAY_DB?: D1Like;
}

export interface RelayContext {
  request: Request;
  env: RelayEnv;
}

export const DEFAULT_LIMITS = {
  dailyCap: 5000, // every request from every install, per UTC day
  installPerMinute: 30,
  installPerDay: 600,
  ipPerMinute: 60,
  ipPerDay: 2000,
  registerPerIpDay: 10,
  registerDailyCap: 2000,
};
export type Limits = typeof DEFAULT_LIMITS;

export const GENERATE_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
export const AGENT_MODELS = ["gemini-3.8-flash"];

export const GENERATE_MAX_BYTES = 200_000;
export const INTERACTIONS_MAX_BYTES = 8_000_000;
export const MAX_IMAGES = 4; // the agent keeps its newest 3 screenshots in a turn
export const MAX_IMAGE_CHARS = 3_000_000; // base64; a 1280-wide JPEG is far smaller
export const MAX_RESPONSE_BYTES = 2_000_000;
const SKEW_S = 300;
const GOOGLE = "https://generativelanguage.googleapis.com/v1beta";

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function limitsOf(env: RelayEnv): Limits {
  return {
    dailyCap: num(env.RELAY_DAILY_REQUEST_CAP, DEFAULT_LIMITS.dailyCap),
    installPerMinute: num(env.RELAY_INSTALL_PER_MINUTE, DEFAULT_LIMITS.installPerMinute),
    installPerDay: num(env.RELAY_INSTALL_PER_DAY, DEFAULT_LIMITS.installPerDay),
    ipPerMinute: num(env.RELAY_IP_PER_MINUTE, DEFAULT_LIMITS.ipPerMinute),
    ipPerDay: num(env.RELAY_IP_PER_DAY, DEFAULT_LIMITS.ipPerDay),
    registerPerIpDay: num(env.RELAY_REGISTER_PER_IP_DAY, DEFAULT_LIMITS.registerPerIpDay),
    registerDailyCap: num(env.RELAY_REGISTER_DAILY_CAP, DEFAULT_LIMITS.registerDailyCap),
  };
}

const list = (value: string | undefined, fallback: string[]): string[] => {
  const items = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
};

// ------------------------------------------------------------------------------------------------------------
// Errors: shaped like Google's ({"error": {code, status, message}}) plus a reason word the apps turn into plain words

export type Reason =
  | "disabled"
  | "auth"
  | "clock"
  | "blocked"
  | "busy"
  | "daily_limit"
  | "budget"
  | "bad_request"
  | "too_large"
  | "model"
  | "upstream"
  | "upstream_key"
  | "upstream_timeout";

export const MESSAGES = {
  disabled: "AGENCY's AI is switched off for now, so the built-in plan is used.",
  notSetUp: "AGENCY's AI isn't set up on this server, so the built-in plan is used.",
  auth: "This computer isn't registered with AGENCY's AI (it registers again by itself).",
  clock: "This computer's clock is off by more than five minutes.",
  blocked: "This computer can't use AGENCY's AI.",
  busy: "AGENCY's AI is busy. Try again in a minute.",
  dailyLimit:
    "AGENCY's AI has reached today's limit for this computer, so the built-in plan is used until tomorrow.",
  budget: "AGENCY's AI has reached its daily limit, so the built-in plan is used until tomorrow.",
  upstreamKey: "AGENCY's AI isn't available right now.",
  timeout: "Gemini didn't answer in time.",
} as const;

const STATUS_NAMES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  405: "INVALID_ARGUMENT",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

export function relayError(
  code: number,
  reason: Reason,
  message: string,
  extra: { retryAfter?: number; serverTime?: number } = {},
): Response {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (extra.retryAfter) headers["retry-after"] = String(Math.max(1, Math.ceil(extra.retryAfter)));
  const error = {
    code,
    status: STATUS_NAMES[code] ?? "UNKNOWN",
    reason,
    message,
    ...(extra.serverTime ? { serverTime: extra.serverTime } : {}),
  };
  return new Response(JSON.stringify({ error }), { status: code, headers });
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** A request this relay won't send on. */
class Rejected extends Error {
  constructor(
    message: string,
    readonly code = 400,
    readonly reason: Reason = "bad_request",
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------------------------------------------------
// Signatures

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
function b64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
const hmac = async (secret: string, data: string): Promise<ArrayBuffer> =>
  crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));

export const INSTALL_ID = /^i_[A-Za-z0-9_-]{22}$/;

/** The secret for an install: derived, so nothing needs storing to check a signature. */
export async function installSecret(master: string, installId: string): Promise<string> {
  return b64url(await hmac(master, `agency-cloud-install:${installId}`));
}

export async function sha256Hex(body: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", body));
}

export function canonical(method: string, path: string, time: string, bodyHash: string): string {
  return ["AGENCY-CLOUD-1", method.toUpperCase(), path, time, bodyHash].join("\n");
}

/** What the apps compute (Python and TypeScript do the same); exported for tests and the local harness. */
export async function signRequest(
  secret: string,
  method: string,
  path: string,
  time: number,
  body: string,
): Promise<string> {
  return hex(await hmac(secret, canonical(method, path, String(time), await sha256Hex(enc.encode(body)))));
}

/** A keyed hash of the network address: limits per network without keeping the address. */
async function networkKey(env: RelayEnv, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return hex(await hmac(env.RELAY_SIGNING_SECRET ?? "", `network:${ip}`)).slice(0, 24);
}

async function readBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Rejected("Request too large.", 413, "too_large");
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw new Rejected("Request too large.", 413, "too_large");
  return body;
}

async function authenticate(request: Request, env: RelayEnv, body: ArrayBuffer): Promise<string> {
  const id = request.headers.get("x-agency-install") ?? "";
  const time = request.headers.get("x-agency-time") ?? "";
  const sig = (request.headers.get("x-agency-signature") ?? "").toLowerCase();
  if (!INSTALL_ID.test(id) || !/^\d{9,11}$/.test(time) || !/^[0-9a-f]{64}$/.test(sig))
    throw new Rejected(MESSAGES.auth, 401, "auth");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(time)) > SKEW_S) throw new ClockOff(now);
  const key = await hmacKey(await installSecret(env.RELAY_SIGNING_SECRET ?? "", id));
  const data = enc.encode(
    canonical(request.method, new URL(request.url).pathname, time, await sha256Hex(body)),
  );
  // crypto.subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", key, fromHex(sig), data)))
    throw new Rejected(MESSAGES.auth, 401, "auth");
  if (list(env.RELAY_BLOCKED_INSTALLS, []).includes(id)) throw new Rejected(MESSAGES.blocked, 403, "blocked");
  return id;
}

class ClockOff extends Error {
  constructor(readonly serverTime: number) {
    super(MESSAGES.clock);
  }
}

// ------------------------------------------------------------------------------------------------------------
// Counters

export interface Counters {
  /** Adds one to each key (created with the given lifetime) and returns the new values, in order. */
  add(keys: { key: string; ttlS: number }[]): Promise<number[]>;
}

export class MemoryCounters implements Counters {
  private readonly counts = new Map<string, { n: number; exp: number }>();
  constructor(private readonly max = 50_000) {}

  async add(keys: { key: string; ttlS: number }[]): Promise<number[]> {
    const now = Date.now();
    if (this.counts.size > this.max) {
      for (const [k, v] of this.counts) if (v.exp <= now) this.counts.delete(k);
      for (const k of this.counts.keys()) {
        if (this.counts.size <= this.max) break;
        this.counts.delete(k);
      }
    }
    return keys.map(({ key, ttlS }) => {
      const e = this.counts.get(key);
      const live = e && e.exp > now;
      const next = { n: live ? e.n + 1 : 1, exp: live ? e.exp : now + ttlS * 1000 };
      this.counts.set(key, next);
      return next.n;
    });
  }

  clear(): void {
    this.counts.clear();
  }
}

/** Atomic counters in D1 (one batch, one transaction): exact across every Cloudflare location. */
export class D1Counters implements Counters {
  private ready: Promise<unknown> | null = null;
  constructor(private readonly db: D1Like) {}

  async add(keys: { key: string; ttlS: number }[]): Promise<number[]> {
    this.ready ??= this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS relay_counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)",
      )
      .run();
    try {
      await this.ready;
    } catch (e) {
      this.ready = null;
      throw e;
    }
    const now = Math.floor(Date.now() / 1000);
    const statements = keys.map(({ key, ttlS }) =>
      this.db
        .prepare(
          "INSERT INTO relay_counters (k, n, exp) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n",
        )
        .bind(key, now + ttlS),
    );
    // Now and then, forget counters whose minute or day is over.
    if (Math.random() < 0.02)
      statements.push(this.db.prepare("DELETE FROM relay_counters WHERE exp < ?1").bind(now));
    const results = await this.db.batch(statements);
    const values = keys.map((_, i) => Number((results[i]?.results?.[0] as { n?: unknown } | undefined)?.n));
    if (values.some((v) => !Number.isFinite(v))) throw new Error("unexpected counter result");
    return values;
  }
}

const memory = new MemoryCounters();
const d1 = new WeakMap<D1Like, D1Counters>();
/** Requests from installs or networks already over a limit, so they don't cost a counter write each. */
const held = new Map<string, { until: number; reason: "busy" | "daily_limit" | "budget"; cap?: number }>();

/** For tests: forget every in-memory counter and hold. */
export function resetRelayState(): void {
  memory.clear();
  held.clear();
}

async function count(env: RelayEnv, keys: { key: string; ttlS: number }[]): Promise<number[]> {
  const db = env.RELAY_DB;
  if (db) {
    let store = d1.get(db);
    if (!store) d1.set(db, (store = new D1Counters(db)));
    try {
      return await store.add(keys);
    } catch {
      console.warn("agency-cloud: counter store unavailable; counting in memory");
    }
  }
  return memory.add(keys);
}

const DAY_S = 86_400;

function hold(key: string, until: number, reason: "busy" | "daily_limit" | "budget", cap?: number): Response {
  if (held.size > 10_000) held.clear();
  held.set(key, { until, reason, ...(cap !== undefined ? { cap } : {}) });
  return limitResponse(reason, until);
}

function limitResponse(reason: "busy" | "daily_limit" | "budget", until: number): Response {
  const message =
    reason === "busy" ? MESSAGES.busy : reason === "budget" ? MESSAGES.budget : MESSAGES.dailyLimit;
  return relayError(429, reason, message, { retryAfter: (until - Date.now()) / 1000 });
}

/** Counts this request against its install, its network and the day's budget; a 429 response when over one. */
export async function admit(env: RelayEnv, installId: string, network: string): Promise<Response | null> {
  const limits = limitsOf(env);
  const now = Date.now();
  for (const key of [`i:${installId}`, `n:${network}`, "g"]) {
    const h = held.get(key);
    if (!h || h.until <= now) continue;
    if (key === "g" && h.cap !== limits.dailyCap) continue; // the cap was changed: count again
    return limitResponse(h.reason, h.until);
  }
  const minute = Math.floor(now / 60_000);
  const day = new Date(now).toISOString().slice(0, 10);
  const nextMinute = (minute + 1) * 60_000;
  const nextDay = Date.parse(day) + DAY_S * 1000;
  const [im, id, nm, nd] = await count(env, [
    { key: `im:${installId}:${minute}`, ttlS: 120 },
    { key: `id:${installId}:${day}`, ttlS: 2 * DAY_S },
    { key: `nm:${network}:${minute}`, ttlS: 120 },
    { key: `nd:${network}:${day}`, ttlS: 2 * DAY_S },
  ]);
  if (im! > limits.installPerMinute) return hold(`i:${installId}`, nextMinute, "busy");
  if (nm! > limits.ipPerMinute) return hold(`n:${network}`, nextMinute, "busy");
  if (id! > limits.installPerDay) return hold(`i:${installId}`, nextDay, "daily_limit");
  if (nd! > limits.ipPerDay) return hold(`n:${network}`, nextDay, "daily_limit");
  // Only requests that passed their own limits count toward the day's budget, so one noisy install can't use it up.
  const [all] = await count(env, [{ key: `g:${day}`, ttlS: 2 * DAY_S }]);
  if (all! > limits.dailyCap) return hold("g", nextDay, "budget", limits.dailyCap);
  return null;
}

// ------------------------------------------------------------------------------------------------------------
// Request checks

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function onlyKeys(o: Json, allowed: readonly string[], where: string): void {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Rejected(`${where}: "${clean(extra, 40)}" isn't accepted.`);
}

function text(value: unknown, max: number, where: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value)) throw new Rejected(`${where} must be text.`);
  if (value.length > max) throw new Rejected(`${where} is too long.`, 413, "too_large");
  return value;
}

function int(value: unknown, min: number, max: number, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Rejected(`${where} must be a whole number from ${min} to ${max}.`);
  return value;
}

function allowedModel(value: unknown, models: string[]): string {
  if (typeof value !== "string" || !models.includes(value))
    throw new Rejected(`AGENCY Cloud doesn't offer the model "${clean(value, 64)}".`, 400, "model");
  return value;
}

const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];
/** Forced on every answer, whatever the app asked for. */
export const SAFETY_SETTINGS = SAFETY_CATEGORIES.map((category) => ({
  category,
  threshold: "BLOCK_MEDIUM_AND_ABOVE",
}));

const THINKING = new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);

/** The coordinator's request: one JSON answer. Returns Google's generateContent body and the deadline. */
export function buildGenerate(b: Json, env: RelayEnv): { model: string; body: Json; timeoutMs: number } {
  onlyKeys(
    b,
    ["model", "system", "user", "schema", "maxOutputTokens", "thinkingLevel", "temperature", "timeoutMs"],
    "request",
  );
  const model = allowedModel(b["model"], list(env.RELAY_GENERATE_MODELS, GENERATE_MODELS));
  const system = text(b["system"], 20_000, "system", false);
  const user = text(b["user"], 150_000, "user")!;
  const schema = b["schema"];
  if (schema !== undefined && (!isObject(schema) || JSON.stringify(schema).length > 30_000))
    throw new Rejected("schema must be a JSON schema object under 30 KB.");
  const maxOutputTokens = int(b["maxOutputTokens"], 1, 32_768, "maxOutputTokens") ?? 4096;
  const level = b["thinkingLevel"];
  if (level !== undefined && (typeof level !== "string" || !THINKING.has(level.toUpperCase())))
    throw new Rejected("thinkingLevel must be minimal, low, medium or high.");
  const temperature = b["temperature"];
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2))
    throw new Rejected("temperature must be from 0 to 2.");
  const timeoutMs = int(b["timeoutMs"], 10_000, 60_000, "timeoutMs") ?? 30_000;
  return {
    model,
    timeoutMs,
    body: {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: user }] }],
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens,
        ...(schema ? { responseJsonSchema: schema } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(typeof level === "string" && model.startsWith("gemini-3")
          ? { thinkingConfig: { thinkingLevel: level.toUpperCase() } }
          : {}),
      },
    },
  };
}

const STEP_TYPES = new Set(["user_input", "model_output", "thought", "function_call", "function_result"]);
const MEDIA_REFUSED = new Set(["audio", "video", "document", "file"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AGENT_THINKING = new Set(["minimal", "low", "medium", "high"]);
const TOOL_CHOICE = new Set(["auto", "any", "none", "validated"]);

/** Screenshots are counted and must be inline; files, links, audio and video are refused anywhere in a turn. */
function scanContent(value: unknown, state: { images: number }, depth = 0): void {
  if (depth > 32) throw new Rejected("The request is nested too deeply.");
  if (Array.isArray(value)) {
    for (const v of value) scanContent(v, state, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  if ("uri" in value || "file_uri" in value || "fileUri" in value)
    throw new Rejected("Links to files aren't accepted; screenshots are sent inline.");
  const type = value["type"];
  if (typeof type === "string" && MEDIA_REFUSED.has(type))
    throw new Rejected("Only text and screenshots are accepted.");
  if (type === "image") {
    state.images += 1;
    if (state.images > MAX_IMAGES) throw new Rejected(`At most ${MAX_IMAGES} screenshots in one turn.`);
    const data = value["data"];
    if (typeof data !== "string" || !IMAGE_TYPES.has(String(value["mime_type"])))
      throw new Rejected("A screenshot must be inline PNG, JPEG or WebP data.");
    if (data.length > MAX_IMAGE_CHARS) throw new Rejected("A screenshot is too large.", 413, "too_large");
  }
  for (const v of Object.values(value)) scanContent(v, state, depth + 1);
}

function checkTool(tool: unknown): Json {
  if (!isObject(tool)) throw new Rejected("Each tool must be an object.");
  if (tool["type"] === "function") {
    onlyKeys(tool, ["type", "name", "description", "parameters"], "function tool");
    if (typeof tool["name"] !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(tool["name"]))
      throw new Rejected("A function tool needs a short name.");
    text(tool["description"], 4000, "tool description", false);
    if (tool["parameters"] !== undefined && !isObject(tool["parameters"]))
      throw new Rejected("Tool parameters must be a JSON schema object.");
    if (JSON.stringify(tool["parameters"] ?? {}).length > 12_000)
      throw new Rejected("Tool parameters are too large.", 413, "too_large");
    return tool;
  }
  if (tool["type"] === "computer_use") {
    onlyKeys(
      tool,
      ["type", "environment", "enable_prompt_injection_detection", "excluded_predefined_functions"],
      "computer_use tool",
    );
    if (tool["environment"] !== "desktop" && tool["environment"] !== "browser")
      throw new Rejected("computer_use environment must be desktop or browser.");
    const excluded = tool["excluded_predefined_functions"] ?? [];
    if (!Array.isArray(excluded) || excluded.length > 30 || excluded.some((e) => typeof e !== "string"))
      throw new Rejected("excluded_predefined_functions must be a short list of names.");
    // Gemini's own prompt-injection detection stays on, whatever the app sent.
    return { ...tool, enable_prompt_injection_detection: true, excluded_predefined_functions: excluded };
  }
  throw new Rejected("Only function and computer_use tools are accepted.");
}

/** The agent's request: one stateless Interactions turn. Returns the body sent to Google. */
export function buildInteraction(b: Json, env: RelayEnv): { model: string; body: Json; timeoutMs: number } {
  onlyKeys(b, ["model", "store", "system_instruction", "tools", "generation_config", "input"], "request");
  const model = allowedModel(b["model"], list(env.RELAY_AGENT_MODELS, AGENT_MODELS));
  if (b["store"] !== undefined && b["store"] !== false)
    throw new Rejected("store must be false: AGENCY Cloud keeps nothing at Google.");
  const system = text(b["system_instruction"], 60_000, "system_instruction", false);
  const toolsIn = b["tools"] ?? [];
  if (!Array.isArray(toolsIn) || toolsIn.length > 64) throw new Rejected("tools must be a list of up to 64.");
  const tools = toolsIn.map(checkTool);
  const config = b["generation_config"] ?? {};
  if (!isObject(config)) throw new Rejected("generation_config must be an object.");
  onlyKeys(
    config,
    ["thinking_level", "tool_choice", "max_output_tokens", "temperature"],
    "generation_config",
  );
  if (config["thinking_level"] !== undefined && !AGENT_THINKING.has(String(config["thinking_level"])))
    throw new Rejected("thinking_level must be minimal, low, medium or high.");
  if (config["tool_choice"] !== undefined && !TOOL_CHOICE.has(String(config["tool_choice"])))
    throw new Rejected("tool_choice must be auto, any, none or validated.");
  int(config["max_output_tokens"], 1, 16_384, "max_output_tokens");
  const t = config["temperature"];
  if (t !== undefined && (typeof t !== "number" || t < 0 || t > 2))
    throw new Rejected("temperature must be from 0 to 2.");
  const input = b["input"];
  if (!Array.isArray(input) || input.length === 0 || input.length > 600)
    throw new Rejected("input must be a list of up to 600 steps.");
  for (const step of input) {
    if (!isObject(step) || typeof step["type"] !== "string" || !STEP_TYPES.has(step["type"]))
      throw new Rejected(
        "input steps must be user input, model output, thoughts, function calls or results.",
      );
  }
  scanContent(input, { images: 0 });
  return {
    model,
    timeoutMs: 90_000,
    body: {
      model,
      store: false, // forced: nothing kept on Google's side
      ...(system ? { system_instruction: system } : {}),
      tools,
      generation_config: config,
      input,
    },
  };
}

// ------------------------------------------------------------------------------------------------------------
// Gemini

async function upstream(env: RelayEnv, url: string, body: Json, timeoutMs: number): Promise<Json | Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY ?? "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    console.warn("agency-cloud: upstream", timedOut ? "timeout" : "network");
    return timedOut
      ? relayError(504, "upstream_timeout", MESSAGES.timeout)
      : relayError(502, "upstream", "Couldn't reach Gemini.");
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  const raw = declared > MAX_RESPONSE_BYTES ? "" : await res.text().catch(() => "");
  if (!res.ok) {
    console.warn("agency-cloud: upstream status", res.status);
    // Our key itself (revoked, billing off): every model would fail the same way, and it isn't the app's fault.
    if (res.status === 401 || res.status === 403)
      return relayError(502, "upstream_key", MESSAGES.upstreamKey);
    let message = "";
    try {
      message = clean((JSON.parse(raw) as { error?: { message?: unknown } }).error?.message, 300);
    } catch {
      message = "";
    }
    const code = [400, 404, 429, 500, 502, 503, 504].includes(res.status) ? res.status : 502;
    return relayError(code, "upstream", message || `Gemini returned an error (${res.status}).`);
  }
  if (!raw || raw.length > MAX_RESPONSE_BYTES)
    return relayError(502, "upstream", "Gemini's answer was too large.");
  try {
    const data = JSON.parse(raw) as unknown;
    if (isObject(data)) return data;
  } catch {
    // fall through
  }
  return relayError(502, "upstream", "Gemini's answer wasn't readable.");
}

/** Only the parts of Google's answer the apps read. */
function pickGenerate(data: Json): Json {
  const candidates = Array.isArray(data["candidates"]) ? data["candidates"].slice(0, 1) : [];
  const feedback = isObject(data["promptFeedback"]) ? data["promptFeedback"] : undefined;
  return {
    candidates: candidates.map((c) =>
      isObject(c) ? { content: c["content"], finishReason: c["finishReason"] } : {},
    ),
    ...(feedback?.["blockReason"] ? { promptFeedback: { blockReason: feedback["blockReason"] } } : {}),
    ...(isObject(data["usageMetadata"]) ? { usageMetadata: data["usageMetadata"] } : {}),
    ...(typeof data["modelVersion"] === "string" ? { modelVersion: data["modelVersion"] } : {}),
  };
}

function pickInteraction(data: Json): Json {
  const out: Json = {};
  for (const k of ["id", "status", "steps", "errors", "usage", "model"]) if (k in data) out[k] = data[k];
  return out;
}

// ------------------------------------------------------------------------------------------------------------
// Handlers

function notReady(env: RelayEnv): Response | null {
  const flag = (env.RELAY_ENABLED ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return relayError(503, "disabled", MESSAGES.disabled);
  if (!env.GEMINI_API_KEY || (env.RELAY_SIGNING_SECRET ?? "").length < 32)
    return relayError(503, "disabled", MESSAGES.notSetUp);
  return null;
}

function refusal(e: unknown): Response {
  if (e instanceof Rejected) return relayError(e.code, e.reason, e.message);
  if (e instanceof ClockOff) return relayError(401, "clock", e.message, { serverTime: e.serverTime });
  console.warn("agency-cloud: internal error");
  return relayError(500, "upstream", "Something went wrong in AGENCY Cloud.");
}

/** POST /api/relay/v1/register: a new anonymous install. Nothing about the computer or person is asked or kept. */
export async function handleRegister({ request, env }: RelayContext): Promise<Response> {
  const off = notReady(env);
  if (off) return off;
  try {
    await readBody(request, 1024);
    const limits = limitsOf(env);
    const network = await networkKey(env, request);
    const day = new Date().toISOString().slice(0, 10);
    const nextDay = Date.parse(day) + DAY_S * 1000;
    const [fromNetwork, all] = await count(env, [
      { key: `rn:${network}:${day}`, ttlS: 2 * DAY_S },
      { key: `rg:${day}`, ttlS: 2 * DAY_S },
    ]);
    if (fromNetwork! > limits.registerPerIpDay) return limitResponse("daily_limit", nextDay);
    if (all! > limits.registerDailyCap) return limitResponse("budget", nextDay);
    const id = `i_${b64url(crypto.getRandomValues(new Uint8Array(16)).buffer)}`;
    return ok({
      installId: id,
      secret: await installSecret(env.RELAY_SIGNING_SECRET ?? "", id),
      limits: { perMinute: limits.installPerMinute, perDay: limits.installPerDay },
    });
  } catch (e) {
    return refusal(e);
  }
}

/** GET /api/relay/v1/status (signed): is this install known and the relay on. Costs no tokens. */
export async function handleStatus({ request, env }: RelayContext): Promise<Response> {
  const off = notReady(env);
  if (off) return off;
  try {
    const installId = await authenticate(request, env, await readBody(request, 0));
    const limits = limitsOf(env);
    return ok({
      ok: true,
      installId,
      models: {
        generate: list(env.RELAY_GENERATE_MODELS, GENERATE_MODELS),
        agent: list(env.RELAY_AGENT_MODELS, AGENT_MODELS),
      },
      limits: { perMinute: limits.installPerMinute, perDay: limits.installPerDay },
    });
  } catch (e) {
    return refusal(e);
  }
}

async function relay(
  { request, env }: RelayContext,
  maxBytes: number,
  build: (b: Json, env: RelayEnv) => { model: string; body: Json; timeoutMs: number },
  url: (model: string) => string,
  pick: (data: Json) => Json,
): Promise<Response> {
  const off = notReady(env);
  if (off) return off;
  try {
    const raw = await readBody(request, maxBytes);
    const installId = await authenticate(request, env, raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Rejected("Not JSON.");
    }
    if (!isObject(parsed)) throw new Rejected("Expected a JSON object.");
    const { model, body, timeoutMs } = build(parsed, env);
    const denied = await admit(env, installId, await networkKey(env, request));
    if (denied) return denied;
    const data = await upstream(env, url(model), body, timeoutMs);
    return data instanceof Response ? data : ok(pick(data));
  } catch (e) {
    return refusal(e);
  }
}

/** POST /api/relay/v1/generate (signed): one JSON answer for the coordinator. */
export const handleGenerate = (ctx: RelayContext): Promise<Response> =>
  relay(
    ctx,
    GENERATE_MAX_BYTES,
    buildGenerate,
    (model) => `${GOOGLE}/models/${model}:generateContent`,
    pickGenerate,
  );

/** POST /api/relay/v1/interactions (signed): one turn of the computer-use agent. */
export const handleInteractions = (ctx: RelayContext): Promise<Response> =>
  relay(ctx, INTERACTIONS_MAX_BYTES, buildInteraction, () => `${GOOGLE}/interactions`, pickInteraction);
