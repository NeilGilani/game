/** Connect Four rules and the CPU (alpha-beta over a simple four-in-a-row window score). */

export type Disc = 1 | 2; // 1 = the person, 2 = the computer
export type C4Board = (Disc | 0)[][]; // [row][col], row 0 at the top
export type C4Level = "easy" | "hard";

export const ROWS = 6;
export const COLS = 7;

export const emptyC4 = (): C4Board => Array.from({ length: ROWS }, () => Array<Disc | 0>(COLS).fill(0));

/** The row a disc dropped into `col` lands on, or -1 when the column is full. */
export function dropRow(board: C4Board, col: number): number {
  for (let r = ROWS - 1; r >= 0; r--) if (board[r]![col] === 0) return r;
  return -1;
}

export function drop(board: C4Board, col: number, disc: Disc): C4Board {
  const r = dropRow(board, col);
  if (r < 0) return board;
  const next = board.map((row) => row.slice());
  next[r]![col] = disc;
  return next;
}

const DIRS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/** The winning four, as [row, col] cells, if there is one. */
export function c4Winner(board: C4Board): { disc: Disc; cells: [number, number][] } | null {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const d = board[r]![c];
      if (!d) continue;
      for (const [dr, dc] of DIRS) {
        const cells: [number, number][] = [[r, c]];
        for (let k = 1; k < 4; k++) {
          const rr = r + dr * k;
          const cc = c + dc * k;
          if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || board[rr]![cc] !== d) break;
          cells.push([rr, cc]);
        }
        if (cells.length === 4) return { disc: d, cells };
      }
    }
  return null;
}

export const c4Full = (board: C4Board) => board[0]!.every((x) => x !== 0);
export const openCols = (board: C4Board) => [3, 2, 4, 1, 5, 0, 6].filter((c) => board[0]![c] === 0);

function windowScore(cells: (Disc | 0)[], me: Disc): number {
  const mine = cells.filter((x) => x === me).length;
  const theirs = cells.filter((x) => x !== 0 && x !== me).length;
  if (mine && theirs) return 0;
  if (mine === 3) return 6;
  if (mine === 2) return 2;
  if (theirs === 3) return -8;
  if (theirs === 2) return -2;
  return 0;
}

function heuristic(board: C4Board, me: Disc): number {
  let s = 0;
  for (let r = 0; r < ROWS; r++)
    s += (board[r]![3] === me ? 3 : 0) - (board[r]![3] && board[r]![3] !== me ? 3 : 0);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      for (const [dr, dc] of DIRS) {
        const er = r + dr * 3;
        const ec = c + dc * 3;
        if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
        s += windowScore(
          [0, 1, 2, 3].map((k) => board[r + dr * k]![c + dc * k]!),
          me,
        );
      }
  return s;
}

function search(board: C4Board, depth: number, alpha: number, beta: number, turn: Disc, me: Disc): number {
  const w = c4Winner(board);
  if (w) return w.disc === me ? 10000 + depth : -10000 - depth;
  if (c4Full(board)) return 0;
  if (depth === 0) return heuristic(board, me);
  const maximizing = turn === me;
  let best = maximizing ? -Infinity : Infinity;
  for (const c of openCols(board)) {
    const v = search(drop(board, c, turn), depth - 1, alpha, beta, turn === 1 ? 2 : 1, me);
    if (maximizing) {
      best = Math.max(best, v);
      alpha = Math.max(alpha, v);
    } else {
      best = Math.min(best, v);
      beta = Math.min(beta, v);
    }
    if (alpha >= beta) break;
  }
  return best;
}

/** The computer's column. Easy looks one move ahead and sometimes plays anywhere; Hard looks six ahead. */
export function c4CpuMove(board: C4Board, level: C4Level, random: () => number = Math.random): number {
  const cols = openCols(board);
  if (cols.length === 0) throw new Error("Board full");
  if (level === "easy" && random() < 0.35) return cols[Math.floor(random() * cols.length)]!;
  const depth = level === "easy" ? 2 : 6;
  let best = -Infinity;
  let pick: number[] = [];
  for (const c of cols) {
    const v = search(drop(board, c, 2), depth - 1, -Infinity, Infinity, 1, 2);
    if (v > best) {
      best = v;
      pick = [c];
    } else if (v === best) pick.push(c);
  }
  return pick[Math.floor(random() * pick.length)]!;
}
