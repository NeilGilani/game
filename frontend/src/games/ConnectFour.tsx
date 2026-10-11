/** Connect Four against the computer: each column is one big target; the disc drops to the lowest free row. */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { GameFrame, LeaveButtons, LevelPicker, resetSelection, type SayTone } from "./GameFrame";
import {
  c4CpuMove,
  c4Full,
  c4Winner,
  COLS,
  drop,
  dropRow,
  emptyC4,
  type C4Board,
  type C4Level,
} from "./connect4";

const CPU_PAUSE_MS = 700;

export function ConnectFour() {
  const [level, setLevel] = useState<C4Level | null>(null);
  if (!level) {
    return (
      <LevelPicker<C4Level>
        game="Connect Four"
        levels={[
          { id: "easy", label: "Easy", sub: "Makes mistakes", icon: "sparkle" },
          { id: "hard", label: "Hard", sub: "Plans ahead", icon: "target" },
        ]}
        onPick={setLevel}
      />
    );
  }
  return <C4Game level={level} onChangeLevel={() => setLevel(null)} />;
}

function C4Game({ level, onChangeLevel }: { level: C4Level; onChangeLevel: () => void }) {
  const [board, setBoard] = useState<C4Board>(emptyC4);
  const [lastCpu, setLastCpu] = useState<[number, number] | null>(null);
  const [score, setScore] = useState({ you: 0, cpu: 0, draw: 0 });
  const win = c4Winner(board);
  const over = !!win || c4Full(board);
  const discs = board.flat().filter(Boolean).length;
  const cpuTurn = !over && discs % 2 === 1;

  useEffect(() => {
    resetSelection();
  }, [board]);

  useEffect(() => {
    if (!cpuTurn) return;
    const t = setTimeout(() => {
      const col = c4CpuMove(board, level);
      setLastCpu([dropRow(board, col), col]);
      setBoard(drop(board, col, 2));
    }, CPU_PAUSE_MS);
    return () => clearTimeout(t);
  }, [cpuTurn, level, board]);

  const result = !over ? null : win ? (win.disc === 1 ? "you" : "cpu") : "draw";
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

  const [say, tone]: [string, SayTone] =
    result === "you"
      ? ["Four in a row. You win!", "win"]
      : result === "cpu"
        ? ["The computer got four in a row.", "lose"]
        : result === "draw"
          ? ["The board is full: it's a draw.", "draw"]
          : cpuTurn
            ? ["The computer is thinking…", "wait"]
            : discs === 0
              ? ["You are yellow. Look at a column to drop your disc there.", "turn"]
              : ["Your turn. Look at a column to drop your disc.", "turn"];

  const winning = new Set(win?.cells.map(([r, c]) => `${r}-${c}`));
  return (
    <GameFrame
      game="Connect Four"
      level={level === "easy" ? "Easy" : "Hard"}
      say={say}
      tone={tone}
      detail={
        over
          ? "Look at Play again for another game."
          : lastCpu && !cpuTurn
            ? `The computer dropped its disc in column ${lastCpu[1] + 1}.`
            : undefined
      }
      board={
        <div className="c4-board" role="group" aria-label="Connect Four board, 7 columns">
          {Array.from({ length: COLS }, (_, c) => {
            const playable = !over && !cpuTurn && dropRow(board, c) >= 0;
            return (
              <button
                key={c}
                className="c4-col"
                disabled={!playable}
                onClick={() => playable && setBoard((b) => drop(b, c, 1))}
                aria-label={`Column ${c + 1}${dropRow(board, c) < 0 ? ", full" : ""}`}
                {...(playable ? { "data-dwell": "" } : {})}
              >
                {board.map((row, r) => (
                  <span
                    key={r}
                    className="c4-hole"
                    data-disc={row[c] === 1 ? "you" : row[c] === 2 ? "cpu" : undefined}
                    data-win={winning.has(`${r}-${c}`) || undefined}
                    data-last={(lastCpu && lastCpu[0] === r && lastCpu[1] === c) || undefined}
                    aria-hidden
                  />
                ))}
              </button>
            );
          })}
        </div>
      }
      status={
        <dl className="game-score" aria-label="Score">
          <div>
            <dt>You · yellow</dt>
            <dd>{score.you}</dd>
          </div>
          <div>
            <dt>Computer · red</dt>
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
            onClick={() => {
              setBoard(emptyC4());
              setLastCpu(null);
            }}
            disabled={discs === 0}
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
