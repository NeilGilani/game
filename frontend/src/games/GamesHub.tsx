/** Games: big tiles for games the person plays with their eyes against the computer. */
import { useEffect } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import "../styles/games.css";

export const GAMES = [
  { id: "tictactoe", label: "Tic-tac-toe", sub: "Three in a row · quick", glyph: "✕◯" },
  { id: "connect4", label: "Connect Four", sub: "Four in a row · a few minutes", glyph: "●●" },
  { id: "chess", label: "Chess", sub: "The full game · take your time", glyph: "♞" },
] as const;

export function GamesHub() {
  useEffect(() => {
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  }, []);
  return (
    <div className="flow games-hub" aria-label="Games">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="sparkle" size={18} /> Games
        </div>
        <h1 id="games-prompt" tabIndex={-1}>
          What would you like to play?
        </h1>
        <p className="muted">You play against the computer. Look at a game until its ring fills.</p>
      </div>
      <div className="flow-options" data-count={GAMES.length} role="group" aria-labelledby="games-prompt">
        {GAMES.map((g) => (
          <button
            key={g.id}
            className="choice game-tile"
            data-game={g.id}
            onClick={() => navigate(`/games/${g.id}`)}
            data-dwell
          >
            <span className="choice-pic game-tile-art" aria-hidden>
              {g.id === "tictactoe" ? <TttArt /> : g.id === "connect4" ? <C4Art /> : <ChessArt />}
            </span>
            <span className="choice-label">{g.label}</span>
            <span className="choice-sub">{g.sub}</span>
          </button>
        ))}
      </div>
      <div className="flow-bar" role="group" aria-label="Move around">
        <button className="btn btn-xl" onClick={() => navigate("/flow/watch")} data-dwell>
          <Icon name="back" /> Back
        </button>
        <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
      </div>
    </div>
  );
}

function TttArt() {
  return (
    <svg viewBox="0 0 90 90" width="96" height="96">
      <g stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.35">
        <path d="M32 8v74M58 8v74M8 32h74M8 58h74" />
      </g>
      <g className="art-x" strokeWidth="6" strokeLinecap="round">
        <path d="M12 12l14 14M26 12 12 26M38 38l14 14M52 38 38 52M64 64l14 14M78 64 64 78" />
      </g>
      <g className="art-o" strokeWidth="6" fill="none">
        <circle cx="71" cy="19" r="8" />
        <circle cx="19" cy="71" r="8" />
      </g>
    </svg>
  );
}

function C4Art() {
  const discs = [
    [0, 3, "a"],
    [1, 3, "b"],
    [1, 2, "a"],
    [2, 3, "b"],
    [2, 2, "a"],
    [3, 3, "a"],
    [2, 1, "b"],
    [3, 2, "b"],
  ] as const;
  return (
    <svg viewBox="0 0 96 80" width="104" height="88">
      <rect x="2" y="2" width="92" height="76" rx="12" className="art-frame" />
      {Array.from({ length: 16 }, (_, k) => {
        const c = k % 4;
        const r = Math.floor(k / 4);
        const d = discs.find(([dc, dr]) => dc === c && dr === r);
        return (
          <circle
            key={k}
            cx={16 + c * 21.3}
            cy={14 + r * 17.5}
            r="7.5"
            className={d ? (d[2] === "a" ? "art-you" : "art-cpu") : "art-hole"}
          />
        );
      })}
    </svg>
  );
}

function ChessArt() {
  return <span className="game-tile-glyph">{"♞︎"}</span>;
}
