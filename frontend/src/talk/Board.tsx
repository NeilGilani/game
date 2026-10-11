/**
 * The core-word board: build a message from core words and predictions, then speak it.
 * Twelve words per page, coloured by part of speech, with word predictions from the person's
 * own history and phrase predictions from the memory tree.
 */

import { useEffect, useMemo, useState } from "react";
import { CORE_WORDS, WordModel, applyWord, predictPhrases } from "../../../os/tasks/src/index";
import type { Suggestion } from "../../../os/contracts/src/memory";
import { Icon } from "../components/Icon";
import { likely } from "../input/context";
import { useTalk } from "./services";
import { MY_PHRASES, useBoards, useHistory } from "./storage";
import { BigPager, usePages } from "./ui";
import { useSpeak } from "./useSpeak";

export function Board() {
  const { memory } = useTalk();
  const history = useHistory();
  const { addPhrase } = useBoards();
  const { speak, speaking } = useSpeak();
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [memorySuggestions, setMemorySuggestions] = useState<Suggestion[]>([]);
  // Fix the page size on entry so choices never move under a steady gaze.
  // A short MacBook window shows one row and keeps Previous / Next visible.
  const [wordsPerPage] = useState(() => (window.innerHeight <= 860 ? 6 : 12));
  const pages = usePages(CORE_WORDS, wordsPerPage);

  useEffect(() => {
    let live = true;
    void memory.suggestions("talk", 6).then((s) => live && setMemorySuggestions(s));
    return () => {
      live = false;
    };
  }, [memory]);

  const said = useMemo(() => history.items.map((h) => h.text), [history.items]);
  const model = useMemo(() => new WordModel(said), [said]);
  const words = model.next(message, 5);
  // Core words the person's own word model predicts next are weakly likely targets for eye control.
  const predicted = new Set(words.map((w) => w.text.toLowerCase()));
  const phrases = message.trim() === "" ? predictPhrases("", said, memorySuggestions, 3) : [];

  const add = (word: string) => {
    setSaved(null);
    setMessage((m) => applyWord(m, word));
  };
  const deleteWord = () => setMessage((m) => m.replace(/\S+\s*$/, "").replace(/\s*$/, m.trim() ? " " : ""));
  const onSpeak = async () => {
    const text = message.trim();
    if (!text) return;
    await speak(text);
    setMessage("");
    setSaved(text);
  };

  return (
    <div className="talk-board" aria-label="Word board">
      <div className="talk-message-row">
        <output className="talk-message" aria-live="polite" aria-label="Your message">
          {message.trim() || <span className="talk-placeholder">Choose words to build a message</span>}
        </output>
        <button
          className="btn btn-primary talk-speak"
          onClick={() => void onSpeak()}
          disabled={!message.trim() || speaking}
          data-dwell
        >
          <Icon name="play" size={30} /> {speaking ? "Speaking…" : "Speak"}
        </button>
      </div>

      <div className="talk-predict-row" role="group" aria-label="Predictions">
        {phrases.map((p) => (
          <button
            key={`p-${p.text}`}
            className="btn talk-btn talk-phrase-chip"
            title={p.reason}
            onClick={() => void speak(p.text)}
            data-dwell
          >
            <Icon name="sparkle" /> {p.text}
          </button>
        ))}
        {words.slice(0, phrases.length ? 2 : 5).map((w) => (
          <button
            key={`w-${w.text}`}
            className="btn talk-btn talk-word-chip"
            title={w.reason}
            onClick={() => add(w.text)}
            data-dwell
          >
            {w.text}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn talk-btn btn-quiet" onClick={deleteWord} disabled={!message.trim()} data-dwell>
          <Icon name="back" /> Delete word
        </button>
        <button
          className="btn talk-btn btn-quiet"
          onClick={() => setMessage("")}
          disabled={!message.trim()}
          data-dwell
        >
          <Icon name="x" /> Clear
        </button>
      </div>

      <div className="talk-words" role="group" aria-label="Core words">
        {pages.items.map((w) => (
          <button
            key={w.text}
            className={`talk-word wc-${w.cls}`}
            onClick={() => add(w.text)}
            data-dwell
            {...likely(predicted.has(w.text.toLowerCase()) && "weak")}
          >
            {w.text}
          </button>
        ))}
      </div>

      <div className="talk-board-foot">
        <BigPager label="Words" {...pages} />
        {saved && (
          <button
            className="btn talk-btn"
            onClick={() => {
              addPhrase(MY_PHRASES, saved);
              setSaved(null);
            }}
            data-dwell
          >
            <Icon name="plus" /> Save “{saved.length > 28 ? `${saved.slice(0, 28)}…` : saved}” as a phrase
          </button>
        )}
      </div>
    </div>
  );
}
