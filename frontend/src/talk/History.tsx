/** What I said: newest first, say it again with one look, erase everything with confirmation. */

import { useState } from "react";
import { ConfirmSheet } from "../components/common";
import { Icon } from "../components/Icon";
import { useHistory } from "./storage";
import { BigPager, usePages } from "./ui";
import { useSpeak } from "./useSpeak";

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function History() {
  const { items, clear } = useHistory();
  const { speak } = useSpeak();
  const [erasing, setErasing] = useState(false);
  const newest = [...items].reverse();
  const pages = usePages(newest, 6);
  return (
    <div className="talk-stack">
      <p className="talk-muted">
        Saved only on this computer. AGENCY uses it to predict your words. You can erase it at any time.
      </p>
      {items.length === 0 ? (
        <p className="talk-empty">
          Nothing yet. What you say on the word board and phrase boards shows up here.
        </p>
      ) : (
        <div className="talk-phrases">
          {pages.items.map((h, i) => (
            <button
              key={`${h.at}-${i}`}
              className="talk-phrase talk-history-item"
              onClick={() => void speak(h.text)}
              data-dwell
            >
              <span>{h.text}</span>
              <span className="talk-when">{when(h.at)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="talk-row">
        <BigPager label="History" {...pages} />
        <span className="spacer" />
        {items.length > 0 && (
          <button className="btn talk-btn btn-danger" onClick={() => setErasing(true)} data-dwell>
            <Icon name="x" /> Erase history
          </button>
        )}
      </div>
      {erasing && (
        <ConfirmSheet
          title="Erase everything you've said?"
          confirmLabel="Erase all"
          tone="danger"
          onConfirm={() => {
            clear();
            setErasing(false);
          }}
          onCancel={() => setErasing(false)}
        >
          <p>
            This removes {items.length} saved message{items.length === 1 ? "" : "s"} from this computer. Word
            predictions start fresh. Your phrase boards stay.
          </p>
        </ConfirmSheet>
      )}
    </div>
  );
}
