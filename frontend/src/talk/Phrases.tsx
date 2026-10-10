/** Phrase boards: pick a board, then look at a phrase to say it at once. */

import { useState } from "react";
import { ConfirmSheet } from "../components/common";
import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import { MY_PHRASES, useBoards } from "./storage";
import { BigPager, usePages } from "./ui";
import { useSpeak } from "./useSpeak";

export function PhraseBoards() {
  const { boards } = useBoards();
  const pages = usePages(boards, 6);
  return (
    <div className="talk-stack">
      <div className="talk-tiles">
        {pages.items.map((b) => (
          <button
            key={b.id}
            className="tile talk-tile"
            onClick={() => navigate(`/talk/phrases/${b.id}`)}
            data-dwell
          >
            <span className="tile-title">{b.title}</span>
            <span className="tile-sub">
              {b.phrases.length} phrase{b.phrases.length === 1 ? "" : "s"}:{" "}
              {b.phrases.slice(0, 2).join(" · ")}
            </span>
          </button>
        ))}
        {!boards.some((b) => b.id === MY_PHRASES) && (
          <div className="tile talk-tile talk-tile-empty">
            <span className="tile-title">My phrases</span>
            <span className="tile-sub">
              Speak a message on the word board, then choose “Save as a phrase”.
            </span>
          </div>
        )}
      </div>
      <BigPager label="Boards" {...pages} />
    </div>
  );
}

export function PhraseBoardView({ id }: { id: string }) {
  const { boards, removePhrase } = useBoards();
  const { speak, speaking } = useSpeak();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const board = boards.find((b) => b.id === id);
  const pages = usePages(board?.phrases ?? [], 8);
  if (!board)
    return (
      <div className="talk-stack">
        <p>That board doesn't exist any more.</p>
        <button className="btn talk-btn" onClick={() => navigate("/talk/phrases")} data-dwell>
          <Icon name="back" /> All boards
        </button>
      </div>
    );
  return (
    <div className="talk-stack">
      <div className="talk-row">
        <button className="btn talk-btn btn-quiet" onClick={() => navigate("/talk/phrases")} data-dwell>
          <Icon name="back" /> All boards
        </button>
        <h2 className="talk-board-title">{board.title}</h2>
        <span className="spacer" />
        <button
          className="btn talk-btn btn-quiet"
          onClick={() => setEditing((e) => !e)}
          aria-pressed={editing}
          data-dwell
        >
          <Icon name="edit" /> {editing ? "Done editing" : "Edit"}
        </button>
      </div>
      <div className="talk-phrases">
        {pages.items.map((p) => (
          <button
            key={p}
            className={`talk-phrase ${editing ? "talk-phrase-editing" : ""}`}
            onClick={() => (editing ? setRemoving(p) : void speak(p))}
            disabled={speaking && !editing}
            data-dwell
          >
            {editing && <Icon name="x" />} {p}
          </button>
        ))}
      </div>
      <BigPager label="Phrases" {...pages} />
      {removing && (
        <ConfirmSheet
          title="Remove this phrase?"
          confirmLabel="Remove it"
          tone="danger"
          onConfirm={() => {
            removePhrase(board.id, removing);
            setRemoving(null);
          }}
          onCancel={() => setRemoving(null)}
        >
          <p className="talk-big-quote">“{removing}”</p>
        </ConfirmSheet>
      )}
    </div>
  );
}
