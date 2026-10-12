/**
 * Types local to the agent runtime. Shared types come from @agency/contracts; the bridge and task-pack
 * interfaces below are proposed for the contracts in INTEGRATION_REQUEST.md.
 */

import type {
  ChoiceQuestion,
  ConsequentialKind,
  NativeMethod,
  NativeMethods,
  RiskLevel,
  TaskRequest,
} from "@agency/contracts";
import type { SafetySettings } from "./policy/settings";
import type { GuardedTools } from "./tools/guarded";

/** The four tool tiers, most structured first. The runtime always prefers the earliest tier that works. */
export type ToolTier = "pack" | "bridge" | "native" | "computer";

export const TIER_ORDER: readonly ToolTier[] = ["pack", "bridge", "native", "computer"];

/** What an action acts on, resolved by the runtime from live state (never taken from the model's word). */
export interface ActionTarget {
  /** Bridge element ref or AX target id. */
  ref?: string;
  label?: string;
  role?: string;
  /** Web origin (bridge) or app bundle id (native, computer). */
  origin?: string;
  url?: string;
  /** Global screen point (computer use). */
  point?: [number, number];
  /** Password or other secure field. */
  secure?: boolean;
  /** A hint from a sandbox page or task pack; may only raise risk, never lower it. */
  riskHint?: ConsequentialKind;
  /** True when the target belongs to a simulated world (sandbox site, fake app). */
  simulated?: boolean;
}

/** What the model (or a pack) says about the action. Used only to raise risk and to explain; never to lower it. */
export interface ActionClaim {
  risk?: RiskLevel;
  kind?: ConsequentialKind;
  /** One plain sentence shown to the person. */
  summary?: string;
  details?: Record<string, string>;
  /** Amount in the smallest sensible unit the model saw, e.g. 24.8 (dollars). */
  amount?: number;
}

export interface AgentAction {
  tier: ToolTier;
  /** e.g. "bridge.click", "bridge.type", "bridge.navigate", "native.press", "computer.left_click", "pack.order.place". */
  op: string;
  target?: ActionTarget;
  /** Inputs that change the effect: text to type, URL, keys, pack tool inputs. */
  input?: Record<string, unknown>;
  claim?: ActionClaim;
  /** Facts the runtime read from the live page or screen (e.g. the order total). Part of the fingerprint. */
  facts?: Record<string, string>;
  /** Image or text preview for the approval screen. Not part of the fingerprint. */
  preview?: { kind: "screenshot" | "text" | "document"; data: string };
}

// --- AGENCY Bridge (Instance 5) -------------------------------------------------------------------

/** One element of a web page's accessibility-like tree, flattened in document order. */
export interface PageNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  /** Password, card number, one-time-code fields (autocomplete="current-password", "cc-number", "one-time-code"). */
  secure?: boolean;
  disabled?: boolean;
  /** autocomplete attribute, used to spot secret and personal-data fields. */
  autocomplete?: string;
  /** data-agency-risk hint from sandbox pages: raises risk only. */
  risk?: ConsequentialKind;
  /** True for buttons that submit a form. */
  submits?: boolean;
  /** Links: the absolute http(s) address. Lets a pack open a link instead of clicking it. */
  href?: string;
  /** Radios, checkboxes and switches: whether it is on. */
  checked?: boolean;
  /** Nesting under structural elements (groups, forms), when the bridge reports it. */
  depth?: number;
  /** Selects: the labels of its options. */
  options?: string[];
}

export interface PageSnapshot {
  tabId: string;
  url: string;
  origin: string;
  title: string;
  nodes: PageNode[];
  /** Visible text of the page, in reading order, truncated by the bridge. Untrusted. */
  text: string;
  /** True for sandbox web world pages. */
  simulated: boolean;
}

export interface BridgeResult {
  ok: boolean;
  error?: string;
}

export interface BrowserBridge {
  snapshot(): Promise<PageSnapshot>;
  /** `approved`: the guard got the person's approval for this exact click (the bridge may insist on it). */
  click(ref: string, opts?: { approved?: boolean }): Promise<BridgeResult>;
  type(ref: string, text: string): Promise<BridgeResult>;
  navigate(url: string): Promise<BridgeResult>;
  /** Choose an option in a list (a <select>), by its label. Optional: older bridges can't. */
  select?(ref: string, option: string): Promise<BridgeResult>;
}

// --- agency-native (Instance 3), reached through the main process ---------------------------------

export interface NativeClient {
  call<M extends NativeMethod>(
    method: M,
    params: NativeMethods[M]["params"],
  ): Promise<NativeMethods[M]["result"]>;
}

// --- Task packs (Instance 8) ----------------------------------------------------------------------

export interface PackStep {
  id: string;
  title: string;
  risk: RiskLevel;
  run(ctx: PackContext): Promise<StepOutcome>;
}

export interface StepOutcome {
  /** True only when the expected state was read back and confirmed. */
  verified: boolean;
  summary: string;
  evidence?: string;
  /** What the whole task did, in the person's words, for the final report (the last step's wins). */
  outcome?: string;
  /**
   * Something may have happened that couldn't be read back (an order placed with no confirmation shown): end the
   * task now as "finished but not confirmed", and never run this step again.
   */
  unconfirmed?: boolean;
}

export interface TaskPack {
  id: string;
  title: string;
  /**
   * The safety settings this pack's actions run under, from the caregiver's. Only the ordering pack uses it: it
   * narrows the sites to its own allow-list and its own spending cap. Every other pack and the model use the
   * caregiver's settings as they are.
   */
  safety?(base: SafetySettings, request: TaskRequest): SafetySettings;
  /** True when this pack can do the request without a model. */
  matches(request: TaskRequest): boolean;
  steps(request: TaskRequest): PackStep[];
}

export interface PackContext {
  request: TaskRequest;
  /** Every side effect goes through these guarded tools. */
  tools: GuardedTools;
  /** Ask the person; resolves with the chosen option id (or null with free text in `other`). */
  ask(question: Omit<ChoiceQuestion, "id">): Promise<{ optionId: string | null; other?: string }>;
  /** Values gathered so far (selections + answers). */
  values: Record<string, string>;
  /** Throws when the task was stopped, waits while paused. For packs that wait for a page between actions. */
  checkpoint?(): Promise<void>;
  /** Aborted the moment the task is stopped. */
  signal?: AbortSignal;
}
