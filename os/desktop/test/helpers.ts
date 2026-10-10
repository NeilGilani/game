import type { Logger } from "../src/main/log";

export function quietLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (l: string) => lines.push(l);
  return { lines, info: push, warn: push, error: push, raw: push };
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
