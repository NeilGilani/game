/** Tic-tac-toe rules and the CPU: perfect minimax on Hard, a forgetful player on Easy. */

export type Mark = "X" | "O";
export type Cell = Mark | null;
export type Board = Cell[];
export type TttLevel = "easy" | "hard";

export const LINES: [number, number, number][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const emptyBoard = (): Board => Array<Cell>(9).fill(null);

export function winner(board: Board): { mark: Mark; line: [number, number, number] } | null {
  for (const line of LINES) {
    const [a, b, c] = line;
    const m = board[a];
    if (m && m === board[b] && m === board[c]) return { mark: m, line };
  }
  return null;
}

export const isFull = (board: Board) => board.every((c) => c !== null);
export const freeCells = (board: Board) => board.flatMap((c, i) => (c === null ? [i] : []));
export const other = (m: Mark): Mark => (m === "X" ? "O" : "X");

/** Score for `me` with `turn` to play: +10 - depth for a win, 0 for a draw (quicker wins, slower losses). */
function minimax(board: Board, turn: Mark, me: Mark, depth: number): number {
  const w = winner(board);
  if (w) return w.mark === me ? 10 - depth : depth - 10;
  if (isFull(board)) return 0;
  let best = turn === me ? -Infinity : Infinity;
  for (const i of freeCells(board)) {
    board[i] = turn;
    const v = minimax(board, other(turn), me, depth + 1);
    board[i] = null;
    best = turn === me ? Math.max(best, v) : Math.min(best, v);
  }
  return best;
}

/** Every best move for `me` (perfect play). */
export function bestMoves(board: Board, me: Mark): number[] {
  const free = freeCells(board);
  const scores = free.map((i) => {
    const b = board.slice();
    b[i] = me;
    return minimax(b, other(me), me, 1);
  });
  const top = Math.max(...scores);
  return free.filter((_, k) => scores[k] === top);
}

function completing(board: Board, mark: Mark): number | null {
  for (const i of freeCells(board)) {
    const b = board.slice();
    b[i] = mark;
    if (winner(b)) return i;
  }
  return null;
}

/** The CPU's cell. Easy usually takes a win, sometimes blocks, otherwise plays anywhere. */
export function cpuMove(board: Board, me: Mark, level: TttLevel, random: () => number = Math.random): number {
  const free = freeCells(board);
  if (free.length === 0) throw new Error("No free cell");
  const pickOne = (xs: number[]) => xs[Math.floor(random() * xs.length)]!;
  if (level === "hard") return pickOne(bestMoves(board, me));
  const win = completing(board, me);
  if (win !== null && random() < 0.75) return win;
  const block = completing(board, other(me));
  if (block !== null && random() < 0.5) return block;
  if (board[4] === null && random() < 0.3) return 4;
  return pickOne(free);
}
