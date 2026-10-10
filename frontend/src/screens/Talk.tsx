/**
 * Talk: the person's voice.
 *
 * Someone who can't speak or move still needs to say "yes", "I'm thirsty" or "I love you"
 * many times a day, far more often than they need a task done. Talk turns one selection
 * into speech: quick answers, phrase boards, an eye-typing keyboard with word prediction,
 * and a pain reporter. What was said is also shown large on screen, for anyone who
 * didn't hear it. Nothing here is consequential, so nothing needs a confirmation, except
 * clearing a typed message, which can be undone.
 */
import { useEffect, useMemo, useState } from "react";
import { SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { alarm } from "../lifeline/alarm";
import { navigate } from "../state/router";
import { GROUPS, LETTERS, backspace, deleteWord, groupLabel, typeChar, type Layout } from "../talk/keyboard";
import {
  CATEGORIES,
  MY_PHRASES_ID,
  QUICK_ANSWERS,
  loadSaved,
  storeSaved,
  withSaved,
  type PhraseCategory,
} from "../talk/phrases";
import { applySuggestion, splitDraft } from "../talk/predict";
import { say, useTalkSession } from "../talk/session";
import {
  RATES,
  availableVoices,
  loadVoice,
  saveVoice,
  speak,
  speechReady,
  speechSupported,
  stopSpeaking,
} from "../talk/speech";
import {
  AREAS,
  KINDS,
  SEVERITY,
  needsSeverity as kindNeedsSeverity,
  painSentence,
  type Kind,
} from "../talk/pain";
import { predictor } from "../talk/store";

const RECENT_ID = "recent";
const PER_PAGE = 8;

/** Re-checks a browser state that has no change event (speech permission). */
function useSpeechReady(): boolean {
  const [ready, setReady] = useState(speechReady);
  useEffect(() => {
    if (ready) return;
    const id = window.setInterval(() => setReady(speechReady()), 1000);
    return () => window.clearInterval(id);
  }, [ready]);
  return ready;
}

/** Tells the person (and a helper) when the browser won't speak yet, and how to fix it. */
function SpeechNotice() {
  const ready = useSpeechReady();
  if (!speechSupported()) {
    return (
      <div className="banner banner-warn" role="status">
        <Icon name="mute" />
        <span>This browser can't speak. What you choose is still shown in large text.</span>
      </div>
    );
  }
  if (ready) return null;
  return (
    <div className="banner banner-warn" role="status">
      <Icon name="mute" />
      <span>
        Speech starts after one real click or key press on this page (a browser rule). Eye control can't do
        it, so a helper presses this once.
      </span>
      <span className="spacer" />
      <button
        className="btn"
        onClick={() => {
          void alarm().unlock();
          void speak("Speech is on.");
        }}
        data-dwell
      >
        <Icon name="speaker" /> Turn on speech
      </button>
    </div>
  );
}

/** The last thing said, large, with "say again". Shared by every Talk screen. */
function SpokenBar() {
  const { last, speaking } = useTalkSession();
  return (
    <section className="talk-said" aria-label="Last thing said" data-speaking={speaking || undefined}>
      <Icon name="speaker" size={30} />
      <p className="talk-said-text" aria-live="polite">
        {last ? last.text : <span className="muted">What you say appears here, large.</span>}
      </p>
      <span className="spacer" />
      {speaking ? (
        <button className="btn" onClick={stopSpeaking} data-dwell>
          <Icon name="stop" /> Stop
        </button>
      ) : (
        <button
          className="btn"
          onClick={() => last && void say(last.text, { learn: false })}
          disabled={!last}
          data-dwell
        >
          <Icon name="refresh" /> Say again
        </button>
      )}
    </section>
  );
}

function VoiceControls() {
  const [voice, setVoice] = useState(loadVoice);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(availableVoices);
  useEffect(() => {
    if (!speechSupported()) return;
    const update = () => setVoices(availableVoices());
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  const current = voices.find((v) => v.voiceURI === voice.voice);
  const rateIndex = Math.max(0, RATES.indexOf(voice.rate as (typeof RATES)[number]));
  const change = (patch: Partial<typeof voice>) => {
    const next = { ...voice, ...patch };
    setVoice(next);
    saveVoice(next);
    void speak("This is my voice.", next);
  };
  return (
    <div className="row" role="group" aria-label="Voice">
      <button
        className="btn btn-quiet"
        disabled={voices.length < 2}
        onClick={() => {
          const i = current ? voices.indexOf(current) : -1;
          change({ voice: voices[(i + 1) % voices.length]?.voiceURI ?? null });
        }}
        data-dwell
      >
        <Icon name="speaker" /> Voice: {current?.name ?? "system default"}
      </button>
      <button
        className="btn btn-quiet"
        onClick={() => change({ rate: RATES[(rateIndex + 1) % RATES.length]! })}
        data-dwell
      >
        <Icon name="clock" /> Speed: {["slowest", "slow", "normal", "fast", "fastest"][rateIndex]}
      </button>
    </div>
  );
}

/** A gentle call for attention: not an emergency, just "come here". */
async function callSomeone(): Promise<void> {
  const a = alarm();
  a.chime();
  window.setTimeout(() => a.chime(), 1100);
  await say("Can someone come here, please?", { learn: false });
}

export function TalkHome() {
  const { history } = useTalkSession();
  const [saved, setSaved] = useState(loadSaved);
  const [editing, setEditing] = useState(false);

  const categories: PhraseCategory[] = useMemo(() => {
    const list: PhraseCategory[] = [];
    if (history.length) list.push({ id: RECENT_ID, label: "Said today", icon: "resume", phrases: history });
    if (saved.length) list.push({ id: MY_PHRASES_ID, label: "My phrases", icon: "check", phrases: saved });
    return [...list, ...CATEGORIES];
  }, [history, saved]);

  const [chosen, setChosen] = useState<string>(CATEGORIES[0]!.id);
  const category = categories.find((c) => c.id === chosen) ?? categories[0]!;
  // Paging instead of scrolling: when a group has more than fits, the last slot is a
  // "More phrases" tile that cycles through pages. Each group remembers its own page.
  const [pageBy, setPageBy] = useState<Record<string, number>>({});
  const perPage = category.phrases.length > PER_PAGE ? PER_PAGE - 1 : PER_PAGE;
  const pages = Math.max(1, Math.ceil(category.phrases.length / perPage));
  const page = Math.min(pageBy[category.id] ?? 0, pages - 1);
  const shown = category.phrases.slice(page * perPage, (page + 1) * perPage);
  const morePhrases = () => setPageBy((m) => ({ ...m, [category.id]: (page + 1) % pages }));

  useEffect(() => {
    if (category.id !== MY_PHRASES_ID) setEditing(false);
  }, [category.id]);

  const remove = (phrase: string) => {
    const next = saved.filter((p) => p !== phrase);
    setSaved(next);
    storeSaved(next);
    if (!next.length) setEditing(false);
  };

  return (
    <Page label="Talk">
      <h1 className="sr-only">Talk: look at something to say it out loud</h1>
      <SpeechNotice />
      <SpokenBar />

      <div className="talk-quick" role="group" aria-label="Quick answers">
        {QUICK_ANSWERS.map((q) => (
          <button
            key={q.id}
            className="btn btn-xl talk-answer"
            data-answer={q.id}
            onClick={() => void say(q.say, { learn: false })}
            data-dwell
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="talk-actions">
        <button className="btn btn-primary talk-action" onClick={() => navigate("/talk/type")} data-dwell>
          <Icon name="keyboard" size={28} />
          <span>
            Type a message
            <span className="talk-action-sub">with word suggestions</span>
          </span>
        </button>
        <button className="btn talk-action" onClick={() => navigate("/talk/pain")} data-dwell>
          <Icon name="pulse" size={28} />
          <span>
            Something hurts
            <span className="talk-action-sub">say where and how much</span>
          </span>
        </button>
        <button className="btn talk-action" onClick={() => void callSomeone()} data-dwell>
          <Icon name="bell" size={28} />
          <span>
            Come here, please
            <span className="talk-action-sub">a gentle chime, not an emergency</span>
          </span>
        </button>
      </div>

      <div className="talk-cats" role="group" aria-label="Phrase groups">
        {categories.map((c) => (
          <button
            key={c.id}
            className="btn talk-cat"
            aria-pressed={c.id === category.id}
            onClick={() => setChosen(c.id)}
            data-dwell
          >
            <Icon name={c.icon} /> {c.label}
          </button>
        ))}
        {category.id === MY_PHRASES_ID && (
          <button
            className="btn btn-quiet"
            aria-pressed={editing}
            onClick={() => setEditing(!editing)}
            data-dwell
          >
            <Icon name={editing ? "check" : "edit"} /> {editing ? "Done removing" : "Remove phrases"}
          </button>
        )}
      </div>

      <div className="grid grid-4 talk-phrases" aria-label={category.label}>
        {shown.map((p) => (
          <button
            key={`${category.id}:${p}`}
            className="tile talk-phrase"
            data-removing={editing || undefined}
            onClick={() => (editing ? remove(p) : void say(p))}
            aria-label={editing ? `Remove: ${p}` : undefined}
            data-dwell
          >
            <span className="tile-title">{p}</span>
            {editing && (
              <span className="small">
                <Icon name="x" /> Remove
              </span>
            )}
          </button>
        ))}
        {pages > 1 && (
          <button
            key={`more:${category.id}:${page}`}
            className="tile talk-phrase talk-more"
            onClick={morePhrases}
            data-dwell
          >
            <span className="tile-title">
              More phrases <Icon name="right" />
            </span>
            <span className="tile-sub" aria-live="polite">
              Page {page + 1} of {pages}
            </span>
          </button>
        )}
      </div>

      <section className="panel panel-muted row" aria-label="Voice settings">
        <span className="small muted">Voice settings, usually set by a helper:</span>
        <VoiceControls />
      </section>
    </Page>
  );
}

// ---- Eye-typing keyboard ------------------------------------------------------------

const LAYOUT_KEY = "agency.talk.layout";
const DRAFT_KEY = "agency.talk.draft";

function loadString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function storeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function TalkKeyboard() {
  // The draft survives a reload or a Lifeline alert: losing minutes of eye typing hurts.
  const [text, setTextRaw] = useState(() => loadString(DRAFT_KEY, ""));
  const [layout, setLayout] = useState<Layout>(() =>
    loadString(LAYOUT_KEY, "groups") === "letters" ? "letters" : "groups",
  );
  const [group, setGroup] = useState<number | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  const setText = (next: string) => {
    setTextRaw(next);
    storeString(DRAFT_KEY, next);
    setCleared(null);
    setSavedNote(false);
  };

  const { previous, prefix } = splitDraft(text);
  const suggestions = useMemo(() => predictor().suggest(prefix, previous, 4), [prefix, previous]);

  const pick = (ch: string) => {
    setText(typeChar(text, ch));
    setGroup(null);
  };
  const openGroup = (i: number) => {
    setGroup(i);
    // New keys appear where the person is looking; make them look deliberately again.
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  };
  const speakAll = () => {
    if (!text.trim()) return;
    void say(text);
  };
  const clear = () => {
    const before = text;
    setText("");
    setCleared(before);
  };

  return (
    <Page label="Type a message">
      <div className="page-head">
        <div>
          <div className="eyebrow">Talk · type</div>
          <h1>Type a message</h1>
        </div>
        <div className="row">
          <button
            className="btn btn-quiet"
            onClick={() => {
              const next = layout === "groups" ? "letters" : "groups";
              setLayout(next);
              setGroup(null);
              storeString(LAYOUT_KEY, next);
            }}
            data-dwell
          >
            <Icon name="keyboard" /> {layout === "groups" ? "Show all letters" : "Use big letter groups"}
          </button>
          <button className="btn" onClick={() => navigate("/talk")} data-dwell>
            <Icon name="back" /> Back to Talk
          </button>
        </div>
      </div>

      <SpeechNotice />

      <div className="talk-compose">
        <output className="talk-draft" aria-live="polite" aria-label="Your message">
          {text || <span className="muted">Choose letters or words below.</span>}
          <span className="talk-caret" aria-hidden="true" />
        </output>
        <button
          className="btn btn-xl btn-primary talk-speak"
          onClick={speakAll}
          disabled={!text.trim()}
          data-dwell
        >
          <Icon name="speaker" size={30} /> Speak
        </button>
      </div>

      <div className="talk-suggest" role="group" aria-label="Word suggestions">
        {suggestions.map((w) => (
          <button
            key={`s:${w}`}
            className="btn talk-word"
            onClick={() => setText(applySuggestion(text, w))}
            data-dwell
          >
            {w}
          </button>
        ))}
      </div>

      <div className="talk-keys-wrap">
        {layout === "groups" ? (
          group === null ? (
            <div className="talk-keys talk-keys-groups" role="group" aria-label="Letter groups">
              {GROUPS.map((g, i) => (
                <button key={`g${i}`} className="btn talk-key" onClick={() => openGroup(i)} data-dwell>
                  {groupLabel(g)}
                </button>
              ))}
              <button key="g-space" className="btn talk-key" onClick={() => pick(" ")} data-dwell>
                Space
              </button>
            </div>
          ) : (
            <div className="talk-keys talk-keys-groups" role="group" aria-label="Letters">
              {GROUPS[group]!.map((ch) => (
                <button
                  key={`l${group}:${ch}`}
                  className="btn talk-key talk-letter"
                  onClick={() => pick(ch)}
                  data-dwell
                >
                  {ch.toUpperCase()}
                </button>
              ))}
              <button
                key={`l${group}:back`}
                className="btn btn-quiet talk-key"
                onClick={() => setGroup(null)}
                data-dwell
              >
                <Icon name="back" /> Groups
              </button>
            </div>
          )
        ) : (
          <div className="talk-keys talk-keys-all" role="group" aria-label="Letters">
            {LETTERS.map((ch) => (
              <button
                key={`a:${ch}`}
                className="btn talk-key talk-letter"
                onClick={() => pick(ch)}
                data-dwell
              >
                {ch.toUpperCase()}
              </button>
            ))}
            <button key="a:space" className="btn talk-key talk-space" onClick={() => pick(" ")} data-dwell>
              Space
            </button>
          </div>
        )}

        <div className="talk-edit" role="group" aria-label="Edit">
          <button className="btn" onClick={() => setText(backspace(text))} disabled={!text} data-dwell>
            <Icon name="backspace" /> Delete letter
          </button>
          <button className="btn" onClick={() => setText(deleteWord(text))} disabled={!text} data-dwell>
            <Icon name="backspace" /> Delete word
          </button>
          {cleared !== null ? (
            <button className="btn btn-primary" onClick={() => setText(cleared)} data-dwell>
              <Icon name="resume" /> Undo clear
            </button>
          ) : (
            <button className="btn" onClick={clear} disabled={!text} data-dwell>
              <Icon name="x" /> Clear
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              const next = withSaved(loadSaved(), text);
              storeSaved(next);
              setSavedNote(true);
            }}
            disabled={!text.trim() || savedNote}
            data-dwell
          >
            <Icon name="check" /> {savedNote ? "Saved to My phrases" : "Save as phrase"}
          </button>
        </div>
      </div>
    </Page>
  );
}

// ---- Pain and discomfort ------------------------------------------------------------

export function TalkPain() {
  const [kind, setKind] = useState<Kind | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [level, setLevel] = useState<number | null>(null);

  const reset = () => {
    setKind(null);
    setArea(null);
    setDone(null);
    setLevel(null);
  };
  const next = (fn: () => void) => {
    fn();
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
  };
  const finish = (sentence: string, lvl: number | null) => {
    setDone(sentence);
    setLevel(lvl);
    void say(sentence, { learn: false });
  };

  const needsSeverity = kind !== null && kindNeedsSeverity(kind);
  const step = done ? "done" : !kind ? "kind" : !area ? "area" : "severity";

  return (
    <Page label="Something hurts">
      <div className="page-head">
        <div>
          <div className="eyebrow">Talk · something hurts</div>
          <h1>
            {step === "kind"
              ? "What is it?"
              : step === "area"
                ? "Where?"
                : step === "severity"
                  ? "How bad is it?"
                  : "Said"}
          </h1>
        </div>
        <div className="row">
          {step !== "kind" && (
            <button className="btn" onClick={() => next(reset)} data-dwell>
              <Icon name="refresh" /> Start again
            </button>
          )}
          <button className="btn" onClick={() => navigate("/talk")} data-dwell>
            <Icon name="back" /> Back to Talk
          </button>
        </div>
      </div>

      <SpeechNotice />
      <SpokenBar />

      {step === "kind" && (
        <div className="grid grid-4">
          {KINDS.map((k) => (
            <button key={`k:${k.id}`} className="tile" onClick={() => next(() => setKind(k.id))} data-dwell>
              <span className="tile-title">{k.label}</span>
              <span className="tile-sub">{k.sub}</span>
            </button>
          ))}
        </div>
      )}

      {step === "area" && (
        <div className="grid grid-4">
          {AREAS.map((a) => (
            <button
              key={`a:${a}`}
              className="tile talk-area"
              onClick={() =>
                next(() => {
                  setArea(a);
                  if (!needsSeverity) finish(painSentence(kind!, a), null);
                })
              }
              data-dwell
            >
              <span className="tile-title">{a.charAt(0).toUpperCase() + a.slice(1)}</span>
            </button>
          ))}
        </div>
      )}

      {step === "severity" && (
        <div className="talk-severity" role="group" aria-label="How bad">
          {SEVERITY.map((s) => (
            <button
              key={`s:${s.level}`}
              className="btn btn-xl talk-sev"
              data-level={s.level}
              onClick={() => next(() => finish(painSentence(kind!, area!, s), s.level))}
              data-dwell
            >
              <span className="talk-sev-num">{s.level}</span>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {step === "done" && (
        <div className="stack">
          {level !== null && level >= 8 && (
            <div className="panel panel-warn row" role="note">
              <Icon name="alert" />
              <span>
                If this is an emergency or you can't breathe, look at <strong>Help</strong> (top left) or
                close your eyes for a second, three times.
              </span>
            </div>
          )}
          <div className="row">
            <button
              className="btn btn-xl"
              onClick={() => done && void say(done, { learn: false })}
              data-dwell
            >
              <Icon name="refresh" /> Say it again
            </button>
            <button className="btn btn-xl" onClick={() => next(reset)} data-dwell>
              <Icon name="plus" /> Something else
            </button>
            <button className="btn btn-xl btn-primary" onClick={() => navigate("/talk")} data-dwell>
              <Icon name="check" /> Done
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}
