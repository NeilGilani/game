/** Tic-tac-toe against the computer: the person is X and goes first; the winning line lights up. */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { GameFrame, LeaveButtons, LevelPicker, resetSelection, type SayTone } from "./GameFrame";
import { cpuMove, emptyBoard, isFull, winner, type Board, type TttLevel } from "./tictactoe";

const CPU_PAUSE_MS = 700;
const CELL_NAMES = [
  "top left",
  "top middle",
  "top right",
  "middle left",
  "centre",
  "middle right",
  "bottom left",
  "bottom middle",
  "bottom right",
];

export function TicTacToe() {
  const [level, setLevel] = useState<TttLevel | null>(null);
  if (!level) {
    return (
      <LevelPicker<TttLevel>
        game="Tic-tac-toe"
        levels={[
          { id: "easy", label: "Easy", sub: "Makes mistakes", icon: "sparkle" },
          { id: "hard", label: "Hard", sub: "Never loses", icon: "target" },
        ]}
        onPick={setLevel}
      />
    );
  }
  return <TttGame level={level} onChangeLevel={() => setLevel(null)} />;
}

function TttGame({ level, onChangeLevel }: { level: TttLevel; onChangeLevel: () => void }) {
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [score, setScore] = useState({ you: 0, cpu: 0, draw: 0 });
  const win = winner(board);
  const over = !!win || isFull(board);
  const moves = board.filter(Boolean).length;
  const cpuTurn = !over && moves % 2 === 1;

  useEffect(() => {
    resetSelection();
  }, [board]);

  useEffect(() => {
    if (!cpuTurn) return;
    const t = setTimeout(() => setBoard((b) => place(b, cpuMove(b, "O", level), "O")), CPU_PAUSE_MS);
    return () => clearTimeout(t);
  }, [cpuTurn, level]);

  const result = !over ? null : win ? (win.mark === "X" ? "you" : "cpu") : "draw";
  const counted = useRef(false);
  useEffect(() => {
    if (!result) {
      counted.current = false;
      return;
    }
    if (counted.current) return;
    counted.current = true;
    setScore((s) => ({ ...s, [result]: s[result] + 1 }));
  }, [result]);

  const [say, tone]: [string, SayTone] = win
    ? win.mark === "X"
      ? ["Three in a row. You win!", "win"]
      : ["The computer got three in a row.", "lose"]
    : over
      ? ["It's a draw: nobody got three in a row.", "draw"]
      : cpuTurn
        ? ["The computer is thinking…", "wait"]
        : moves === 0
          ? ["You are X. Look at an empty square to play there.", "turn"]
          : ["Your turn. Look at an empty square.", "turn"];

  return (
    <GameFrame
      game="Tic-tac-toe"
      level={level === "easy" ? "Easy" : "Hard"}
      say={say}
      tone={tone}
      detail={over ? "Look at Play again for another game." : undefined}
      board={
        <div className="ttt-board" role="group" aria-label="Tic-tac-toe board">
          {board.map((cell, i) => {
            const playable = !cell && !over && !cpuTurn;
            return (
              <button
                key={i}
                className="ttt-cell"
                data-mark={cell ?? undefined}
                data-win={win?.line.includes(i) || undefined}
                disabled={!playable}
                onClick={() => playable && setBoard((b) => place(b, i, "X"))}
                aria-label={`${CELL_NAMES[i]}: ${cell === "X" ? "your X" : cell === "O" ? "computer's O" : "empty"}`}
                {...(playable ? { "data-dwell": "" } : {})}
              >
                {cell === "X" ? <MarkX /> : cell === "O" ? <MarkO /> : null}
              </button>
            );
          })}
        </div>
      }
      status={
        <dl className="game-score" aria-label="Score">
          <div>
            <dt>You · X</dt>
            <dd>{score.you}</dd>
          </div>
          <div>
            <dt>Computer · O</dt>
            <dd>{score.cpu}</dd>
          </div>
          <div>
            <dt>Draws</dt>
            <dd>{score.draw}</dd>
          </div>
        </dl>
      }
      actions={
        <>
          <button
            className={`btn btn-xl ${over ? "btn-primary" : ""}`}
            onClick={() => setBoard(emptyBoard())}
            disabled={moves === 0}
            data-dwell
          >
            <Icon name="refresh" /> {over ? "Play again" : "Start over"}
          </button>
          <button className="btn btn-xl" onClick={onChangeLevel} data-dwell>
            <Icon name="target" /> Change level
          </button>
          <LeaveButtons />
        </>
      }
    />
  );
}

function place(board: Board, i: number, mark: "X" | "O"): Board {
  if (board[i] || winner(board)) return board;
  const next = board.slice();
  next[i] = mark;
  return next;
}

function MarkX() {
  return (
    <svg viewBox="0 0 100 100" className="ttt-mark ttt-x" aria-hidden>
      <path d="M24 24 76 76M76 24 24 76" />
    </svg>
  );
}

function MarkO() {
  return (
    <svg viewBox="0 0 100 100" className="ttt-mark ttt-o" aria-hidden>
      <circle cx="50" cy="50" r="27" />
    </svg>
  );
}
