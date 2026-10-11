/** Shared pieces of the game screens: the level picker and the board-plus-guidance window. */
import { useEffect, type ReactNode } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import "../styles/games.css";

/** New targets under the gaze: pause selection briefly so a lingering look doesn't pick one. */
export function resetSelection(): void {
  window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
}

export interface LevelChoice<L extends string> {
  id: L;
  label: string;
  sub: string;
  icon: string;
}

export function LevelPicker<L extends string>({
  game,
  levels,
  onPick,
}: {
  game: string;
  levels: LevelChoice<L>[];
  onPick: (level: L) => void;
}) {
  useEffect(() => {
    resetSelection();
    document.getElementById("level-prompt")?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="flow" aria-label={game}>
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="sparkle" size={18} /> Games · {game}
        </div>
        <h1 id="level-prompt" tabIndex={-1}>
          How well should the computer play?
        </h1>
        <p className="muted">You can change this after any game.</p>
      </div>
      <div className="flow-options" data-count={levels.length} role="group" aria-labelledby="level-prompt">
        {levels.map((l) => (
          <button key={l.id} className="choice" onClick={() => onPick(l.id)} data-dwell>
            <span className="choice-pic" aria-hidden>
              <Icon name={l.icon} size={60} />
            </span>
            <span className="choice-label">{l.label}</span>
            <span className="choice-sub">{l.sub}</span>
          </button>
        ))}
      </div>
      <div className="flow-bar" role="group" aria-label="Move around">
        <button className="btn btn-xl" onClick={() => navigate("/games")} data-dwell>
          <Icon name="back" /> Games
        </button>
        <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
      </div>
    </div>
  );
}

export type SayTone = "turn" | "wait" | "warn" | "win" | "lose" | "draw";

/** The game window: the board on the left, the guidance line, status and big buttons on the right. */
export function GameFrame({
  game,
  level,
  say,
  tone,
  detail,
  board,
  status,
  actions,
}: {
  game: string;
  level: string;
  say: string;
  tone: SayTone;
  detail?: ReactNode;
  board: ReactNode;
  status?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="game" aria-label={game} data-game={game}>
      <div className="game-board-wrap">{board}</div>
      <section className="game-side" aria-label="How the game is going">
        <div className="eyebrow game-eyebrow">
          <Icon name="sparkle" size={18} /> {game} <span className="game-level">{level}</span>
        </div>
        <div className="game-say-box" data-tone={tone}>
          <p className="game-say" id="game-say" aria-live="polite" aria-atomic="true">
            {say}
          </p>
          {detail && <p className="game-detail">{detail}</p>}
        </div>
        {status}
        <div className="game-actions" role="group" aria-label="Game controls">
          {actions}
        </div>
      </section>
    </div>
  );
}

/** Games and Home, the same two buttons at the end of every game's controls. */
export function LeaveButtons() {
  return (
    <>
      <button className="btn btn-xl" onClick={() => navigate("/games")} data-dwell>
        <Icon name="back" /> Games
      </button>
      <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
        <Icon name="home" /> Home
      </button>
    </>
  );
}
