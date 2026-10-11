/**
 * Chess against the computer. The person plays White. Two looks make a move: hold on one of your pieces to pick
 * it up (its legal squares turn green), then hold on a green square. Only those squares are selectable, so a
 * stray look can't do anything wrong. The CPU thinks in a Web Worker so eye control never freezes.
 */
import { Chess, type PieceSymbol, type Square } from "chess.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { askCpu } from "./cpu";
import { DEPTH, type Level } from "./chessEngine";
import { destinations, PIECE_NAME, selectableSquares, selectSquare, type Picked } from "./chessSelection";
import { GameFrame, LeaveButtons, LevelPicker, resetSelection, type SayTone } from "./GameFrame";

const YOU = "w" as const;
const CPU_MIN_MS = 600; // a moment to see that it's the computer's turn, even when it answers at once
const FILES = "abcdefgh";
const GLYPH: Record<PieceSymbol, string> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};
const START_COUNT: Record<PieceSymbol, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

export function ChessGame() {
  const [level, setLevel] = useState<Level | null>(null);
  if (!level) {
    return (
      <LevelPicker<Level>
        game="Chess"
        levels={[
          { id: "easy", label: "Easy", sub: "Looks 2 moves ahead", icon: "sparkle" },
          { id: "normal", label: "Normal", sub: "Looks 3 moves ahead", icon: "target" },
        ]}
        onPick={setLevel}
      />
    );
  }
  return <ChessBoardGame level={level} onChangeLevel={() => setLevel(null)} />;
}

interface LastMove {
  from: Square;
  to: Square;
  text: string;
}

function ChessBoardGame({ level, onChangeLevel }: { level: Level; onChangeLevel: () => void }) {
  const [chess] = useState(() => new Chess());
  const [fen, setFen] = useState(() => chess.fen());
  const [picked, setPicked] = useState<Picked>(null);
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<LastMove | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const game = useRef(0); // bumps on New game and Undo, so a late CPU answer for an old position is dropped

  const sync = () => {
    setFen(chess.fen());
    resetSelection();
  };

  // The computer answers whenever it's Black's turn.
  useEffect(() => {
    if (chess.turn() === YOU || chess.isGameOver()) return;
    const token = game.current;
    let live = true;
    setThinking(true);
    const started = Date.now();
    void askCpu(chess.fen(), DEPTH[level], level === "easy" ? 900 : 1600).then((r) => {
      const wait = Math.max(0, CPU_MIN_MS - (Date.now() - started));
      setTimeout(() => {
        if (!live || token !== game.current || !r.move) return;
        const m = chess.move(r.move);
        const took = m.captured ? ` and took your ${PIECE_NAME[m.captured]}` : "";
        setLast({
          from: m.from,
          to: m.to,
          text: `The computer moved its ${PIECE_NAME[m.piece]} from ${m.from} to ${m.to}${took}.`,
        });
        setThinking(false);
        sync();
      }, wait);
    });
    return () => {
      live = false;
      setThinking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, level]);

  const selectable = useMemo(
    () => (thinking ? new Set<Square>() : selectableSquares(chess, YOU, picked)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fen, picked, thinking],
  );
  const targets = useMemo(
    () => (picked ? destinations(chess, picked) : new Set<Square>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fen, picked],
  );

  const onSquare = (sq: Square) => {
    if (thinking) return;
    const a = selectSquare(chess, YOU, picked, sq);
    if (a.kind === "pick") {
      setPicked(a.square);
      setNote(null);
      resetSelection();
    } else if (a.kind === "cancel") {
      setPicked(null);
      setNote("You put it back.");
      resetSelection();
    } else if (a.kind === "move") {
      const m = chess.move({ from: a.from, to: a.to, promotion: "q" });
      setPicked(null);
      setNote(
        m.promotion
          ? `Your pawn reached the end and became a queen.`
          : m.captured
            ? `You took the computer's ${PIECE_NAME[m.captured]}.`
            : null,
      );
      sync();
    }
  };

  const undo = () => {
    if (thinking) return;
    game.current++;
    // Take back the computer's reply (if any) and your move, so it's your turn again.
    chess.undo();
    if (chess.turn() !== YOU) chess.undo();
    setPicked(null);
    setLast(null);
    setNote("Your last move was taken back.");
    sync();
  };

  const newGame = () => {
    game.current++;
    chess.reset();
    setPicked(null);
    setLast(null);
    setNote(null);
    setThinking(false);
    sync();
  };

  // Guidance: one plain sentence for what to do now.
  const over = chess.isGameOver();
  const inCheck = chess.inCheck();
  const pickedPiece = picked ? chess.get(picked) : undefined;
  let say: string;
  let tone: SayTone = "turn";
  if (chess.isCheckmate()) {
    const youWon = chess.turn() !== YOU;
    say = youWon ? "Checkmate. You win!" : "Checkmate. The computer wins this time.";
    tone = youWon ? "win" : "lose";
  } else if (chess.isStalemate()) {
    say = "Stalemate: no legal moves, so it's a draw.";
    tone = "draw";
  } else if (over) {
    say = chess.isInsufficientMaterial()
      ? "Draw: not enough pieces left to checkmate."
      : chess.isThreefoldRepetition()
        ? "Draw: the same position came up three times."
        : "Draw by the fifty-move rule.";
    tone = "draw";
  } else if (thinking || chess.turn() !== YOU) {
    say = "The computer is thinking…";
    tone = "wait";
  } else if (pickedPiece) {
    const name = PIECE_NAME[pickedPiece.type];
    say = `Now look at a green square to move your ${name} there.`;
  } else if (inCheck) {
    say = "Check! Protect your king: look at a piece to pick it up.";
    tone = "warn";
  } else {
    say = "Look at one of your pieces to pick it up.";
  }
  const detail =
    pickedPiece && !over
      ? `Changed your mind? Look at the ${PIECE_NAME[pickedPiece.type]} again, or at Put it back.`
      : over
        ? "Look at New game to play again."
        : [last?.text, note].filter(Boolean).join(" ") || undefined;

  const captured = capturedPieces(chess);
  const history = chess.history();

  return (
    <GameFrame
      game="Chess"
      level={level === "easy" ? "Easy" : "Normal"}
      say={say}
      tone={tone}
      detail={detail}
      board={
        <div
          className="chess-board"
          role="group"
          aria-label="Chess board, White at the bottom"
          data-picking={picked ? "dest" : "piece"}
        >
          {Array.from({ length: 64 }, (_, k) => {
            const rank = 8 - Math.floor(k / 8);
            const file = FILES[k % 8]!;
            const sq = `${file}${rank}` as Square;
            const piece = chess.get(sq);
            const dark = (k + Math.floor(k / 8)) % 2 === 1;
            const canSelect = selectable.has(sq) && !over;
            const isTarget = targets.has(sq);
            const kingInCheck = inCheck && piece?.type === "k" && piece.color === chess.turn();
            const label = squareLabel(sq, piece?.color, piece?.type, isTarget, sq === picked);
            return (
              <button
                key={sq}
                className="chess-sq"
                data-dark={dark || undefined}
                data-picked={sq === picked || undefined}
                data-target={isTarget || undefined}
                data-capture={(isTarget && !!piece) || undefined}
                data-last={(last && (sq === last.from || sq === last.to)) || undefined}
                data-check={kingInCheck || undefined}
                data-can={canSelect || undefined}
                disabled={!canSelect}
                onClick={() => onSquare(sq)}
                aria-label={label}
                {...(canSelect ? { "data-dwell": "" } : {})}
              >
                {piece && (
                  <span className={`chess-piece chess-piece-${piece.color}`} aria-hidden>
                    {GLYPH[piece.type]}
                    {"︎"}
                  </span>
                )}
                {isTarget && <span className="chess-dot" aria-hidden />}
                {k % 8 === 0 && <span className="chess-coord chess-rank">{rank}</span>}
                {k >= 56 && <span className="chess-coord chess-file">{file}</span>}
              </button>
            );
          })}
        </div>
      }
      status={
        <div className="chess-status">
          <div className="chess-turn" data-whose={thinking || chess.turn() !== YOU ? "cpu" : "you"}>
            <span className="chess-turn-dot" aria-hidden />
            {over
              ? "Game over"
              : thinking || chess.turn() !== YOU
                ? "Computer's turn (Black)"
                : "Your turn (White)"}
            <span className="chess-moves">Move {Math.floor(history.length / 2) + 1}</span>
          </div>
          <div className="chess-captured" aria-label="Captured pieces">
            <span className="chess-captured-label">You took</span>
            <span className="chess-captured-pieces">
              {captured.b.length
                ? captured.b.map((t, i) => <Taken key={i} type={t} color="b" />)
                : "nothing yet"}
            </span>
            <span className="chess-captured-label">Computer took</span>
            <span className="chess-captured-pieces">
              {captured.w.length
                ? captured.w.map((t, i) => <Taken key={i} type={t} color="w" />)
                : "nothing yet"}
            </span>
          </div>
        </div>
      }
      actions={
        <>
          {picked ? (
            <button className="btn btn-xl btn-primary" onClick={() => onSquare(picked)} data-dwell>
              <Icon name="x" /> Put it back
            </button>
          ) : (
            <button
              className="btn btn-xl"
              onClick={undo}
              disabled={thinking || history.length === 0}
              data-dwell
            >
              <Icon name="resume" /> Undo my move
            </button>
          )}
          <button className={`btn btn-xl ${over ? "btn-primary" : ""}`} onClick={newGame} data-dwell>
            <Icon name="refresh" /> New game
          </button>
          {over && (
            <button className="btn btn-xl" onClick={onChangeLevel} data-dwell>
              <Icon name="target" /> Change level
            </button>
          )}
          <LeaveButtons />
        </>
      }
    />
  );
}

function Taken({ type, color }: { type: PieceSymbol; color: "w" | "b" }) {
  return (
    <span className={`chess-piece chess-piece-${color} chess-taken`} title={PIECE_NAME[type]}>
      {GLYPH[type]}
      {"︎"}
    </span>
  );
}

function squareLabel(
  sq: Square,
  color: "w" | "b" | undefined,
  type: PieceSymbol | undefined,
  target: boolean,
  picked: boolean,
): string {
  const what = type ? `${color === YOU ? "your" : "computer's"} ${PIECE_NAME[type]}` : "empty";
  if (picked) return `${sq}, ${what}, picked up: select again to put it back`;
  if (target) return `${sq}, ${what}: move here`;
  return `${sq}, ${what}`;
}

/** Pieces each side has lost, most valuable first (a promoted pawn counts as the piece it became). */
export function capturedPieces(chess: Chess): { w: PieceSymbol[]; b: PieceSymbol[] } {
  const left = { w: { ...START_COUNT }, b: { ...START_COUNT } };
  for (const row of chess.board()) for (const p of row) if (p) left[p.color][p.type]--;
  const order: PieceSymbol[] = ["q", "r", "b", "n", "p"];
  const lost = (c: "w" | "b") => order.flatMap((t) => Array<PieceSymbol>(Math.max(0, left[c][t])).fill(t));
  return { w: lost("w"), b: lost("b") };
}
