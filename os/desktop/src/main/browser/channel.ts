/**
 * Requests from main to a page's preload, and their replies. A reply counts only when it comes from the main frame
 * of the very page it was sent to; anything else is ignored. Replies are data from the internet: callers check them.
 */

import type { WebContents } from "electron";
import { IPC } from "@agency/contracts";

export class PageGone extends Error {
  constructor(
    message = "The page changed or closed before it answered.",
    /** True when the page went away because it moved on to another page (often because of the request itself). */
    readonly navigated = false,
  ) {
    super(message);
  }
}

export class PageCallError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface Pending {
  contentsId: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ReplyMessage {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

/** A reply as it arrives over IPC, checked: null when it isn't one. */
export function parseReply(msg: unknown): ReplyMessage | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== "number" || !Number.isInteger(m.id) || typeof m.ok !== "boolean") return null;
  return {
    id: m.id,
    ok: m.ok,
    result: m.result,
    ...(typeof m.error === "string" ? { error: m.error.slice(0, 300) } : {}),
    ...(typeof m.code === "string" ? { code: m.code.slice(0, 40) } : {}),
  };
}

export class PageChannel {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  call<T>(
    contents: WebContents,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5_000,
  ): Promise<T> {
    if (contents.isDestroyed()) return Promise.reject(new PageGone());
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PageGone("The page didn't answer in time."));
      }, timeoutMs);
      this.pending.set(id, {
        contentsId: contents.id,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        contents.send(IPC.page, { id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PageGone());
      }
    });
  }

  /** A reply from `contentsId`'s main frame (the caller checked the frame). */
  reply(contentsId: number, raw: unknown): void {
    const msg = parseReply(raw);
    if (!msg) return;
    const p = this.pending.get(msg.id);
    if (!p || p.contentsId !== contentsId) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new PageCallError(msg.error ?? "The page couldn't do that.", msg.code ?? "error"));
  }

  /** The page went away (navigated, crashed, closed): its open requests fail now instead of timing out. */
  dropFor(contentsId: number, navigated = false): void {
    for (const [id, p] of this.pending) {
      if (p.contentsId !== contentsId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new PageGone(undefined, navigated));
    }
  }
}
