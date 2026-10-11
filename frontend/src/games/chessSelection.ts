/**
 * Two-step eye selection for chess: hold on one of your pieces to pick it up, then hold on one of its marked
 * squares to move there. Only your pieces that can move, and (once one is picked up) its legal destinations,
 * are selectable, so a stray look can never make an illegal or unintended move.
 */
import type { Chess, PieceSymbol, Square } from "chess.js";

export type Picked = Square | null;

export type SelectAction =
  | { kind: "pick"; square: Square }
  | { kind: "cancel" }
  | { kind: "move"; from: Square; to: Square }
  | { kind: "ignore" };

export const PIECE_NAME: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

/** Your pieces that have at least one legal move (empty when it isn't your turn). */
export function movablePieces(chess: Chess, you: "w" | "b"): Set<Square> {
  if (chess.turn() !== you || chess.isGameOver()) return new Set();
  return new Set(chess.moves({ verbose: true }).map((m) => m.from));
}

/** Legal destination squares of the piece on `from`. */
export function destinations(chess: Chess, from: Square): Set<Square> {
  return new Set(chess.moves({ square: from, verbose: true }).map((m) => m.to));
}

/** The squares that are dwell targets right now. */
export function selectableSquares(chess: Chess, you: "w" | "b", picked: Picked): Set<Square> {
  const movable = movablePieces(chess, you);
  if (!picked || !movable.has(picked)) return movable;
  // While a piece is held: its destinations, the piece itself (to put it back), and your other pieces are not.
  return new Set([picked, ...destinations(chess, picked)]);
}

/** What holding on `square` does. */
export function selectSquare(chess: Chess, you: "w" | "b", picked: Picked, square: Square): SelectAction {
  const movable = movablePieces(chess, you);
  if (picked && movable.has(picked)) {
    if (square === picked) return { kind: "cancel" };
    if (destinations(chess, picked).has(square)) return { kind: "move", from: picked, to: square };
    return { kind: "ignore" };
  }
  if (movable.has(square)) return { kind: "pick", square };
  return { kind: "ignore" };
}
