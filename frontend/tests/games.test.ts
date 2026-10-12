import { Chess, type Square } from "chess.js";
import { describe, expect, it } from "vitest";
import { capturedPieces } from "../src/games/ChessGame";
import { bestMove, DEPTH, evaluate } from "../src/games/chessEngine";
import { destinations, selectableSquares, selectSquare } from "../src/games/chessSelection";
import { c4CpuMove, c4Winner, drop, emptyC4, type C4Board } from "../src/games/connect4";
import { FLOWS } from "../src/flows/library";
import { choose, startFlow } from "../src/flows/engine";
import {
  bestMoves,
  cpuMove,
  emptyBoard,
  freeCells,
  isFull,
  other,
  winner,
  type Board,
  type Mark,
} from "../src/games/tictactoeRules";

describe("tic-tac-toe", () => {
  it("finds the winning line", () => {
    const b: Board = ["X", "X", "X", null, "O", "O", null, null, null];
    expect(winner(b)).toEqual({ mark: "X", line: [0, 1, 2] });
    expect(winner(emptyBoard())).toBeNull();
  });

  it("hard never loses, whoever starts and whatever the opponent plays", () => {
    // Exhaustive: the CPU plays every one of its best moves against every possible opponent move.
    let games = 0;
    const play = (board: Board, turn: Mark, cpu: Mark) => {
      const w = winner(board);
      if (w || isFull(board)) {
        games++;
        expect(w?.mark).not.toBe(other(cpu));
        return;
      }
      const moves = turn === cpu ? bestMoves(board, cpu) : freeCells(board);
      for (const i of moves) {
        const next = board.slice();
        next[i] = turn;
        play(next, other(turn), cpu);
      }
    };
    play(emptyBoard(), "X", "O"); // the person (X) starts
    play(emptyBoard(), "X", "X"); // the CPU starts
    expect(games).toBeGreaterThan(100);
  });

  it("hard takes a win when one is there, and blocks one", () => {
    const win: Board = ["O", "O", null, "X", "X", null, "X", null, null];
    expect(cpuMove(win, "O", "hard")).toBe(2);
    const block: Board = ["X", "X", null, null, "O", null, null, null, null];
    expect(cpuMove(block, "O", "hard")).toBe(2);
  });

  it("easy only plays free cells", () => {
    const b: Board = ["X", null, "O", null, "X", null, null, null, null];
    for (let k = 0; k < 50; k++) expect(freeCells(b)).toContain(cpuMove(b, "O", "easy"));
  });
});

describe("chess CPU", () => {
  it("returns a legal move", () => {
    const fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    const r = bestMove(fen, DEPTH.easy, { timeMs: 3000 });
    const chess = new Chess(fen);
    expect(r.move).not.toBeNull();
    expect(() => chess.move(r.move!)).not.toThrow();
  });

  it("finds a back-rank mate in one", () => {
    const fen = "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1";
    const r = bestMove(fen, DEPTH.easy, { timeMs: 3000 });
    expect(r.move).toEqual({ from: "d1", to: "d8" });
    const chess = new Chess(fen);
    chess.move(r.move!);
    expect(chess.isCheckmate()).toBe(true);
  });

  it("finds mate in one for Black too, and promotes", () => {
    const mate = bestMove("3r2k1/8/8/8/8/8/5PPP/6K1 b - - 0 1", DEPTH.easy, { timeMs: 3000 });
    expect(mate.move).toEqual({ from: "d8", to: "d1" });
    const promo = bestMove("8/P5k1/8/8/8/8/6K1/8 w - - 0 1", DEPTH.easy, { timeMs: 3000 });
    expect(promo.move).toEqual({ from: "a7", to: "a8", promotion: "q" });
  });

  it("takes a free queen and has nothing to play when mated", () => {
    const r = bestMove("4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1", DEPTH.easy, { timeMs: 3000 });
    expect(r.move).toEqual({ from: "d1", to: "d5" });
    const mated = bestMove("3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1", DEPTH.easy);
    expect(mated.move).toBeNull();
  });

  it("evaluates the start position as level", () => {
    expect(evaluate(new Chess())).toBe(0);
  });
});

describe("chess two-step selection", () => {
  it("only your movable pieces are selectable at first", () => {
    const chess = new Chess();
    const s = selectableSquares(chess, "w", null);
    expect([...s].sort()).toEqual(["a2", "b1", "b2", "c2", "d2", "e2", "f2", "g1", "g2", "h2"].sort());
    expect(selectSquare(chess, "w", null, "e4")).toEqual({ kind: "ignore" });
    expect(selectSquare(chess, "w", null, "e7")).toEqual({ kind: "ignore" });
    expect(selectSquare(chess, "w", null, "d1")).toEqual({ kind: "ignore" }); // the queen can't move yet
    expect(selectSquare(chess, "w", null, "g1")).toEqual({ kind: "pick", square: "g1" });
  });

  it("with a piece picked up, only its legal squares (and itself) are selectable", () => {
    const chess = new Chess();
    expect([...selectableSquares(chess, "w", "g1")].sort()).toEqual(["f3", "g1", "h3"]);
    expect(selectSquare(chess, "w", "g1", "f3")).toEqual({ kind: "move", from: "g1", to: "f3" });
    expect(selectSquare(chess, "w", "g1", "g1")).toEqual({ kind: "cancel" });
    for (const sq of ["e2", "e4", "g3", "h1", "e5"] as Square[]) {
      expect(selectSquare(chess, "w", "g1", sq)).toEqual({ kind: "ignore" });
    }
  });

  it("every allowed destination is a legal move, including castling and en passant", () => {
    // White can castle both ways and take en passant on d6.
    const chess = new Chess("r3k2r/pppq1ppp/8/3pP3/8/8/PPPQ1PPP/R3K2R w KQkq d6 0 1");
    expect(destinations(chess, "e1")).toEqual(new Set(["d1", "f1", "c1", "g1", "e2"]));
    expect(destinations(chess, "e5")).toEqual(new Set(["e6", "d6"]));
    for (const from of selectableSquares(chess, "w", null)) {
      for (const to of destinations(chess, from)) {
        const copy = new Chess(chess.fen());
        expect(() => copy.move({ from, to, promotion: "q" })).not.toThrow();
      }
    }
  });

  it("nothing is selectable on the computer's turn or after the game ends", () => {
    const chess = new Chess();
    chess.move("e4");
    expect(selectableSquares(chess, "w", null).size).toBe(0);
    expect(selectSquare(chess, "w", null, "d2")).toEqual({ kind: "ignore" });
    const mated = new Chess("3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1");
    expect(selectableSquares(mated, "b", null).size).toBe(0);
  });

  it("in check, only moves that answer the check are offered", () => {
    const chess = new Chess("4k3/8/8/8/8/8/4r3/R3K3 w Q - 0 1");
    // The rook on a1 can't help (and castling out of check isn't allowed): only the king can move.
    expect(chess.inCheck()).toBe(true);
    expect(selectableSquares(chess, "w", null)).toEqual(new Set(["e1"]));
    expect(destinations(chess, "e1")).toEqual(new Set(["d1", "f1", "e2"]));
  });

  it("counts captured pieces", () => {
    const chess = new Chess("4k3/8/8/8/8/8/8/3QK3 w - - 0 1");
    expect(capturedPieces(chess).b).toEqual([
      "q",
      "r",
      "r",
      "b",
      "b",
      "n",
      "n",
      "p",
      "p",
      "p",
      "p",
      "p",
      "p",
      "p",
      "p",
    ]);
    expect(capturedPieces(chess).w).toHaveLength(14);
  });
});

describe("connect four", () => {
  it("stacks discs and sees four in a row", () => {
    let b: C4Board = emptyC4();
    for (const c of [0, 1, 2, 3]) b = drop(b, c, 1);
    expect(c4Winner(b)?.cells).toEqual([
      [5, 0],
      [5, 1],
      [5, 2],
      [5, 3],
    ]);
  });

  it("hard wins when it can and blocks your three", () => {
    let b = emptyC4();
    for (const c of [0, 1, 2]) b = drop(drop(b, c, 2), c, 1);
    expect(c4CpuMove(b, "hard")).toBe(3); // computer's three on the bottom row: complete it
    let block = emptyC4();
    for (const c of [0, 1, 2]) block = drop(block, c, 1);
    block = drop(block, 6, 2);
    block = drop(block, 6, 2);
    expect(c4CpuMove(block, "hard")).toBe(3);
  });
});

describe("games entry point", () => {
  it("Watch & listen offers Games, which opens the games hub", () => {
    const f = FLOWS.watch!;
    expect(choose(f, startFlow(f), "games").outcome).toEqual({ type: "route", path: "/games" });
  });
});
