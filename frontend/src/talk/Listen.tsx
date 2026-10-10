/**
 * Conversation mode. Off until the person turns it on. In the AGENCY app, agency-native
 * listens with on-device recognition only (audio never leaves the Mac, nothing is recorded);
 * Talk shows what was said and big reply suggestions. Claude suggestions are a second,
 * separate opt-in that shows exactly what would be sent. What was heard is never followed
 * as an instruction.
 */

import { useEffect, useRef, useState } from "react";
import {
  NO_CONSENT,
  claudeSuggestionRequest,
  suggestReplies,
  type ConversationConsent,
  type ReplySuggestion,
} from "../../../os/tasks/src/index";
import { ConfirmSheet } from "../components/common";
import { Icon } from "../components/Icon";
import { useTalk } from "./services";
import { useBoards, useHistory } from "./storage";
import { SimNote } from "./ui";
import { useSpeak } from "./useSpeak";

const PRACTICE = ["How are you feeling today?", "Do you want some water?", "Should we watch the game later?"];

export function Listen() {
  const { native, claudeReplies } = useTalk();
  const { speak } = useSpeak();
  const history = useHistory();
  const { boards } = useBoards();
  const [consent, setConsent] = useState<ConversationConsent>(NO_CONSENT);
  const [heard, setHeard] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [askingClaude, setAskingClaude] = useState(false);
  const [claude, setClaude] = useState<string[]>([]);
  const listeningRef = useRef(false);

  useEffect(() => {
    if (!native?.onEvent) return;
    return native.onEvent((e) => {
      if (!listeningRef.current) return;
      if (e.type === "speech-partial") setPartial(e.text);
      if (e.type === "speech-final") {
        setPartial("");
        setClaude([]);
        setHeard((h) => [...h.slice(-20), e.text]);
      }
    });
  }, [native]);

  // Always stop listening when leaving the screen.
  useEffect(
    () => () => {
      if (listeningRef.current) void native?.invoke("speech.listen", { on: false });
      listeningRef.current = false;
    },
    [native],
  );

  const setListening = async (on: boolean) => {
    setError(null);
    if (native) {
      const r = await native.invoke("speech.listen", { on });
      if (!r.ok) {
        setError(r.error ?? "Listening didn't start. Check Microphone and Speech Recognition in Settings.");
        return;
      }
    }
    listeningRef.current = on;
    setConsent(on ? { ...consent, listening: true } : NO_CONSENT);
    if (!on) {
      setHeard([]);
      setPartial("");
      setClaude([]);
    }
  };

  const last = heard.at(-1) ?? "";
  const personal = boards.flatMap((b) => b.phrases);
  const replies: ReplySuggestion[] = last
    ? [
        ...claude.map((text) => ({ text, source: "claude" as const })),
        ...suggestReplies(last, personal),
      ].slice(0, 6)
    : [];
  const recent = history.items.slice(-3).map((h) => h.text);
  const request = claudeSuggestionRequest(last, recent);

  // With consent for this conversation, each new line gets Claude ideas too.
  const claudeOn = consent.claude && !!claudeReplies;
  useEffect(() => {
    if (!claudeOn || !last || !claudeReplies) return;
    let live = true;
    claudeReplies(claudeSuggestionRequest(last, recent))
      .then((r) => live && setClaude(r.slice(0, 4)))
      .catch(() => live && setError("Claude didn't answer. The usual suggestions are still here."));
    return () => {
      live = false;
    };
    // recent is read at the moment a new line arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeOn, last, claudeReplies]);

  return (
    <div className="talk-stack">
      {!consent.listening ? (
        <>
          <p className="talk-lead">
            When you turn this on, AGENCY listens to the people talking with you, shows their words here, and
            suggests replies you can say with one look.
          </p>
          <ul className="talk-list">
            <li>Listening happens on this Mac only. Nothing is recorded or sent anywhere.</li>
            <li>It stays on only while this screen is open. Turn it off any time.</li>
            <li>Tell the people nearby that AGENCY is listening.</li>
          </ul>
          {native ? (
            <button
              className="btn btn-primary talk-btn-xl"
              onClick={() => void setListening(true)}
              data-dwell
            >
              <Icon name="play" /> Start listening
            </button>
          ) : (
            <>
              <SimNote>
                Listening needs the AGENCY app on a Mac (on-device speech recognition). Here you can practise
                with sample sentences.
              </SimNote>
              <button className="btn talk-btn-xl" onClick={() => void setListening(true)} data-dwell>
                <Icon name="play" /> Practise conversation mode
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <div className="talk-row">
            <span className="talk-live" role="status">
              <span className="talk-live-dot" aria-hidden="true" />{" "}
              {native ? "Listening on this Mac" : "Practice mode"}
            </span>
            <span className="spacer" />
            <button
              className="btn talk-btn"
              onClick={() => setAskingClaude(true)}
              disabled={!last || consent.claude}
              data-dwell
            >
              <Icon name="sparkle" /> {consent.claude ? "Claude ideas on" : "Ideas from Claude…"}
            </button>
            <button className="btn talk-btn btn-quiet" onClick={() => void setListening(false)} data-dwell>
              <Icon name="stop" /> Stop listening
            </button>
          </div>
          <div className="talk-heard" aria-live="polite">
            {heard.length === 0 && !partial && <p className="talk-empty">Waiting for someone to speak…</p>}
            {heard.slice(-3).map((h, i) => (
              <p
                key={`${i}-${h}`}
                className={`talk-heard-line ${i === Math.min(2, heard.length - 1) ? "talk-heard-last" : ""}`}
              >
                “{h}”
              </p>
            ))}
            {partial && <p className="talk-heard-line talk-heard-partial">{partial}…</p>}
          </div>
          {!native && (
            <div className="talk-row" role="group" aria-label="Practice sentences">
              {PRACTICE.map((p) => (
                <button
                  key={p}
                  className="btn talk-btn btn-quiet"
                  onClick={() => setHeard((h) => [...h, p])}
                  data-dwell
                >
                  Pretend: “{p}”
                </button>
              ))}
            </div>
          )}
          <div className="talk-phrases talk-phrases-3">
            {replies.map((r) => (
              <button key={r.text} className="talk-phrase" onClick={() => void speak(r.text)} data-dwell>
                {r.source === "claude" && <Icon name="sparkle" />} {r.text}
              </button>
            ))}
          </div>
        </>
      )}
      {error && (
        <p className="talk-error" role="alert">
          {error}
        </p>
      )}
      {askingClaude && (
        <ConfirmSheet
          title="Ask Claude for reply ideas?"
          confirmLabel={claudeReplies ? "Send this" : "Not available"}
          onConfirm={async () => {
            setAskingClaude(false);
            if (claudeReplies) setConsent((c) => ({ ...c, claude: true }));
          }}
          onCancel={() => setAskingClaude(false)}
        >
          <p>
            {claudeReplies
              ? "This exact text goes to Anthropic's Claude, for this conversation only:"
              : "Claude ideas need the AGENCY agent with an API key. Nothing will be sent. This is what would be sent:"}
          </p>
          <pre className="talk-preview">{request}</pre>
        </ConfirmSheet>
      )}
    </div>
  );
}
