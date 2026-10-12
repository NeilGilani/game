/**
 * Conversation mode. Off until the person turns it on. In the AGENCY app, agency-native
 * listens with on-device recognition only (audio never leaves the Mac, nothing is recorded);
 * Talk shows what was said and big reply suggestions. AI suggestions (Gemini through the
 * coordinator, routed by Synapse-Mesh, or the Mac app's agent) are a second, separate opt-in
 * that shows exactly what would be sent. What was heard is never followed as an instruction.
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
import { aiReplies } from "../state/assist";
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
  // The AI and the on-device suggestions can offer the same words: show each reply once (it is also the key).
  const replies: ReplySuggestion[] = last
    ? [...claude.map((text) => ({ text, source: "claude" as const })), ...suggestReplies(last, personal)]
        .filter((r, i, all) => all.findIndex((o) => o.text.toLowerCase() === r.text.toLowerCase()) === i)
        .slice(0, 6)
    : [];
  const recent = history.items.slice(-3).map((h) => h.text);
  // The Mac app's agent when it offers replies; otherwise Gemini through the coordinator (only the words heard and
  // your last few phrases are sent, after you agree, for this conversation only).
  const viaAgent = !!claudeReplies;
  const request = viaAgent
    ? claudeSuggestionRequest(last, recent)
    : `Heard: ${last}\nYour recent phrases: ${recent.join(" | ") || "none"}`;
  const askAi = async (line: string): Promise<string[]> => {
    if (claudeReplies) return claudeReplies(claudeSuggestionRequest(line, recent));
    const r = await aiReplies(line, [...recent, ...personal.slice(0, 10)]);
    if (!r) throw new Error("no answer");
    return r.replies;
  };

  // With consent for this conversation, each new line gets AI ideas too.
  const claudeOn = consent.claude;
  useEffect(() => {
    if (!claudeOn || !last) return;
    let live = true;
    askAi(last)
      .then((r) => live && setClaude(r.slice(0, 4)))
      .catch(() => live && setError("The AI didn't answer. The usual suggestions are still here."));
    return () => {
      live = false;
    };
    // recent is read at the moment a new line arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeOn, last]);

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
              <Icon name="sparkle" /> {consent.claude ? "AI ideas on" : "Ideas from AI…"}
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
          title="Ask the AI for reply ideas?"
          confirmLabel="Send this"
          onConfirm={async () => {
            setAskingClaude(false);
            setConsent((c) => ({ ...c, claude: true }));
          }}
          onCancel={() => setAskingClaude(false)}
        >
          <p>
            {viaAgent
              ? "This exact text goes to the AGENCY agent's AI model, for this conversation only:"
              : "This goes to Google's Gemini through your AGENCY coordinator (routed by Synapse-Mesh), for this conversation only. Your phrases help it answer in your words:"}
          </p>
          <pre className="talk-preview">{request}</pre>
        </ConfirmSheet>
      )}
    </div>
  );
}
