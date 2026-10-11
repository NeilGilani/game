/** Runs the chess CPU off the main thread so the screen (and eye control) never freezes while it thinks. */
import { bestMove } from "./chessEngine";

interface Request {
  id: number;
  fen: string;
  depth: number;
  timeMs: number;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, fen, depth, timeMs } = e.data;
  const result = bestMove(fen, depth, { timeMs });
  (self as unknown as Worker).postMessage({ id, result });
};
