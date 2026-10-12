/**
 * Papers' small runner rules, the same as the practice agent's: an approval counts only for the exact action that
 * was shown (its fingerprint), it is used once, changing anything needs a new approval, and Stop ends everything at
 * once (an explanation on its way is cancelled, and nothing is saved after Stop).
 */
import { canonicalJson, sha256Hex } from "../../../os/tasks/src/core/sha256";

export interface Proposal {
  kind: "explain" | "fill" | "sign";
  /** The document's name, as shown. */
  document: string;
  /** SHA-256 of the exact bytes the person is looking at. */
  documentSha256: string;
  /** Everything the person was shown about what will happen, word for word. */
  details: Record<string, string>;
}

export class GateRefused extends Error {}

export function fingerprint(p: Proposal): string {
  return sha256Hex(canonicalJson([p.kind, p.document, p.documentSha256, p.details]));
}

export class PapersGate {
  private shown: string | null = null;
  private approved: string | null = null;
  private controller = new AbortController();
  private stoppedNow = false;

  get stopped(): boolean {
    return this.stoppedNow;
  }

  /** Aborted when the person presses Stop. Pass it to anything slow (the explanation request). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Show an action. Any earlier approval no longer counts. Returns the fingerprint to approve. */
  propose(p: Proposal): string {
    this.shown = fingerprint(p);
    this.approved = null;
    return this.shown;
  }

  /** The person said yes to what they were shown. Only the fingerprint on screen can be approved. */
  approve(fp: string): boolean {
    if (this.stoppedNow || fp !== this.shown) return false;
    this.approved = fp;
    return true;
  }

  /**
   * Do the approved action. The proposal is fingerprinted again: if anything differs from what was approved, it
   * doesn't run. The approval is used up either way.
   */
  async perform<T>(p: Proposal, act: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const fp = fingerprint(p);
    const ok = !this.stoppedNow && this.approved !== null && fp === this.approved && fp === this.shown;
    this.approved = null;
    if (!ok)
      throw new GateRefused(
        this.stoppedNow ? "Stopped. Nothing more was done." : "That wasn't the action you approved.",
      );
    const result = await act(this.controller.signal);
    if (this.stoppedNow) throw new GateRefused("Stopped. Nothing more was done.");
    return result;
  }

  /** Before the last irreversible step (writing the file): has Stop been pressed meanwhile? */
  check(): void {
    if (this.stoppedNow) throw new GateRefused("Stopped. Nothing more was done.");
  }

  stop(): void {
    if (this.stoppedNow) return;
    this.stoppedNow = true;
    this.shown = null;
    this.approved = null;
    this.controller.abort();
  }

  /** Start again after Stop (the person chose to). */
  reset(): void {
    this.stoppedNow = false;
    this.shown = null;
    this.approved = null;
    this.controller = new AbortController();
  }
}
