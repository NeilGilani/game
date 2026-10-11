/** Asks the chess CPU for a move in a Web Worker, falling back to small timer-spaced work if workers fail. */
import { bestMove, type SearchResult } from "./chessEngine";

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (r: SearchResult) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./chess.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result: SearchResult }>) => {
      pending.get(e.data.id)?.(e.data.result);
      pending.delete(e.data.id);
    };
    worker.onerror = () => {
      // A broken worker answers nothing: finish waiting requests here instead.
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function askCpu(fen: string, depth: number, timeMs = 1500): Promise<SearchResult> {
  const w = getWorker();
  if (!w) {
    return new Promise((resolve) => setTimeout(() => resolve(bestMove(fen, depth, { timeMs })), 30));
  }
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, fen, depth, timeMs });
    // Should the worker die mid-search, answer on the main thread rather than hang the game.
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve(bestMove(fen, Math.min(depth, 2), { timeMs: 600 }));
    }, timeMs + 4000);
  });
}
