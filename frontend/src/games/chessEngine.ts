/**
 * The chess CPU: alpha-beta search over chess.js (rules), with material plus simple piece-square tables and a
 * short capture-only quiescence search so it doesn't blunder pieces at the end of its horizon.
 *
 * chess.js's public move API builds SAN and two FEN strings for every move, which is far too slow for a search,
 * so this uses its internal move generator (`_moves`, `_makeMove`, `_undoMove`, `_board`). chess.js is pinned to
 * an exact version (frontend/package.json) and tests/games.test.ts checks the engine against it.
 */
import { Chess, type Square } from "chess.js";

export type Level = "easy" | "normal";

/** Search depth in plies for each level. */
export const DEPTH: Record<Level, number> = { easy: 2, normal: 3 };

interface Piece {
  type: "p" | "n" | "b" | "r" | "q" | "k";
  color: "w" | "b";
}
interface InternalMove {
  color: "w" | "b";
  from: number;
  to: number;
  piece: Piece["type"];
  captured?: Piece["type"];
  promotion?: Piece["type"];
  flags: number;
}
interface Internals {
  _board: (Piece | undefined)[];
  _turn: "w" | "b";
  _moves(opts?: { legal?: boolean }): InternalMove[];
  _makeMove(m: InternalMove): void;
  _undoMove(): unknown;
  _isKingAttacked(color: "w" | "b"): boolean;
}

export interface EngineMove {
  from: Square;
  to: Square;
  promotion?: "q" | "r" | "b" | "n";
}

const VALUE: Record<Piece["type"], number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Piece-square tables from White's side, rank 8 first (the "simplified evaluation function" tables).
// prettier-ignore
const PST: Record<Piece["type"], number[]> = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

const MATE = 100000;
const QUIESCENCE_PLIES = 4;

function internals(chess: Chess): Internals {
  return chess as unknown as Internals;
}

function algebraic(i: number): Square {
  return `${"abcdefgh"[i & 7]}${8 - (i >> 4)}` as Square;
}

/** Material plus position, from White's side, in centipawns. */
export function evaluate(chess: Chess): number {
  const board = internals(chess)._board;
  let score = 0;
  for (let i = 0; i < 128; i++) {
    if (i & 0x88) {
      i += 7;
      continue;
    }
    const p = board[i];
    if (!p) continue;
    const row = i >> 4;
    const file = i & 7;
    const idx = p.color === "w" ? row * 8 + file : (7 - row) * 8 + file;
    const v = VALUE[p.type] + PST[p.type][idx]!;
    score += p.color === "w" ? v : -v;
  }
  return score;
}

/** Captures first, most valuable victim by least valuable attacker; then promotions. */
function order(moves: InternalMove[], first?: InternalMove): InternalMove[] {
  const key = (m: InternalMove) =>
    (first && m.from === first.from && m.to === first.to && m.promotion === first.promotion ? 100000 : 0) +
    (m.captured ? 10 * VALUE[m.captured] - VALUE[m.piece] + 1000 : 0) +
    (m.promotion ? VALUE[m.promotion] : 0);
  return moves
    .map((m) => ({ m, k: key(m) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.m);
}

class Timeout extends Error {}

interface Search {
  chess: Internals;
  deadline: number;
  nodes: number;
}

function sideScore(s: Search, chess: Chess): number {
  const e = evaluate(chess);
  return s.chess._turn === "w" ? e : -e;
}

function quiesce(s: Search, chess: Chess, alpha: number, beta: number, qply: number): number {
  const stand = sideScore(s, chess);
  if (stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  if (qply >= QUIESCENCE_PLIES) return alpha;
  const caps = s.chess._moves({ legal: true }).filter((m) => m.captured || m.promotion);
  for (const m of order(caps)) {
    s.chess._makeMove(m);
    const v = -quiesce(s, chess, -beta, -alpha, qply + 1);
    s.chess._undoMove();
    if (v >= beta) return v;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function negamax(s: Search, chess: Chess, depth: number, ply: number, alpha: number, beta: number): number {
  s.nodes++;
  if ((s.nodes & 255) === 0 && Date.now() > s.deadline) throw new Timeout();
  const moves = s.chess._moves({ legal: true });
  if (moves.length === 0) return s.chess._isKingAttacked(s.chess._turn) ? -MATE + ply : 0;
  if (depth === 0) return quiesce(s, chess, alpha, beta, 0);
  let best = -Infinity;
  for (const m of order(moves)) {
    s.chess._makeMove(m);
    const v = -negamax(s, chess, depth - 1, ply + 1, -beta, -alpha);
    s.chess._undoMove();
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

export interface SearchResult {
  move: EngineMove | null;
  score: number;
  depth: number;
  nodes: number;
}

/**
 * The best move for the side to move in `fen`, searching `depth` plies (iterative deepening, so a deadline
 * still returns the best move of the last finished depth). In the opening, `random` adds a little variety among
 * moves that score within a few centipawns of the best, so games don't repeat.
 */
export function bestMove(
  fen: string,
  depth: number,
  opts: { timeMs?: number; random?: () => number } = {},
): SearchResult {
  const chess = new Chess(fen);
  const s: Search = { chess: internals(chess), deadline: Date.now() + (opts.timeMs ?? 1500), nodes: 0 };
  const root = s.chess._moves({ legal: true });
  if (root.length === 0) return { move: null, score: 0, depth: 0, nodes: 0 };
  const random = opts.random ?? Math.random;
  const [placement = "", , , , , fullmove = "1"] = fen.split(" ");
  const opening = Number(fullmove) <= 10 && placement.replace(/[^a-zA-Z]/g, "").length >= 28;
  let chosen: InternalMove = root[0]!;
  let chosenScore = 0;
  let done = 0;
  for (let d = 1; d <= depth; d++) {
    try {
      let alpha = -Infinity;
      const scored: { m: InternalMove; v: number }[] = [];
      for (const m of order(root, chosen)) {
        s.chess._makeMove(m);
        // A narrow window above the best so far, widened by the variety margin so near-equal moves get exact scores.
        const v = -negamax(s, chess, d - 1, 1, -Infinity, -(alpha - 15));
        s.chess._undoMove();
        scored.push({ m, v });
        if (v > alpha) alpha = v;
      }
      const top = alpha;
      // Mates and big swings are never randomized; quiet near-ties are.
      // Variety only in the opening: later, a near-tie can mean "win material now or a move later", and
      // putting it off forever is how a computer fails to finish a won game.
      const margin = Math.abs(top) > MATE / 2 || !opening ? 0 : 12;
      const near = scored.filter((x) => x.v >= top - margin);
      // Without variety, the first best move in search order: captures and promotions come first.
      const pick = (margin ? near[Math.floor(random() * near.length)] : near[0]) ?? scored[0]!;
      chosen = pick.m;
      chosenScore = pick.v;
      done = d;
      if (top > MATE / 2) break; // a forced mate was found: take the shortest one.
    } catch (e) {
      // Out of time: keep the best move of the last finished depth (this board is thrown away).
      if (!(e instanceof Timeout)) throw e;
      break;
    }
  }
  return {
    move: {
      from: algebraic(chosen.from),
      to: algebraic(chosen.to),
      ...(chosen.promotion ? { promotion: chosen.promotion as EngineMove["promotion"] } : {}),
    },
    score: chosenScore,
    depth: done,
    nodes: s.nodes,
  };
}
