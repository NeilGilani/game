/**
 * Emergency phrases: spoken at once, loudly and first. Getting help always goes through
 * Lifeline (the host passes requestHelp); Talk never contacts anyone itself.
 */

import { useState } from "react";
import { EMERGENCY_PHRASES } from "../../../os/tasks/src/index";
import { Icon } from "../components/Icon";
import { useTalk } from "./services";
import { useSpeak } from "./useSpeak";

export function Emergency() {
  const { requestHelp } = useTalk();
  const { speak } = useSpeak();
  const [helpSent, setHelpSent] = useState(false);
  return (
    <div className="talk-stack">
      <button
        className="btn btn-solid-danger talk-help"
        onClick={() => {
          requestHelp();
          setHelpSent(true);
        }}
        data-dwell
      >
        <Icon name="lifeline" size={34} /> {helpSent ? "Lifeline is getting help" : "Get help now (Lifeline)"}
      </button>
      <p className="talk-muted">Say it out loud to the people nearby:</p>
      <div className="talk-phrases talk-phrases-2">
        {EMERGENCY_PHRASES.map((p) => (
          <button
            key={p.text}
            className="talk-phrase talk-phrase-urgent"
            onClick={() => void speak(p.text)}
            data-dwell
          >
            <Icon name="alert" /> {p.text}
          </button>
        ))}
      </div>
    </div>
  );
}
