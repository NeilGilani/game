/** Choose the voice, and whether to use Apple's Personal Voice when the person has made one. */

import { Icon } from "../components/Icon";
import { useVoiceSettings } from "./storage";
import { BigPager, SimNote, usePages } from "./ui";
import { useSpeak } from "./useSpeak";

export function VoiceSettings() {
  const { voice, setVoice } = useVoiceSettings();
  const { voices, voice: current, speak, kind } = useSpeak();
  const hasPersonal = voices.some((v) => v.personal);
  const others = voices.filter((v) => !v.personal);
  const pages = usePages(others, 6);
  return (
    <div className="talk-stack">
      {kind !== "native" && (
        <SimNote>
          This is the browser's voice. In the AGENCY app, Talk uses the Mac's voices, including your Personal
          Voice.
        </SimNote>
      )}
      <div className="talk-row">
        <button
          className="btn talk-btn"
          aria-pressed={voice.usePersonalVoice}
          onClick={() => setVoice({ ...voice, usePersonalVoice: !voice.usePersonalVoice })}
          disabled={!hasPersonal}
          data-dwell
        >
          <Icon name={voice.usePersonalVoice && hasPersonal ? "check" : "x"} />
          {hasPersonal
            ? voice.usePersonalVoice
              ? "Using my Personal Voice"
              : "Use my Personal Voice"
            : "No Personal Voice on this Mac"}
        </button>
        <button
          className="btn talk-btn btn-primary"
          onClick={() => void speak("Hello, this is my voice.", { remember: false })}
          data-dwell
        >
          <Icon name="play" /> Test: “Hello, this is my voice.”
        </button>
      </div>
      {!hasPersonal && (
        <p className="talk-muted">
          To make a Personal Voice, a helper can open System Settings, then Accessibility, then Personal
          Voice. Then allow AGENCY to use it.
        </p>
      )}
      <p className="talk-muted">Now speaking with: {current ? current.name : "the system voice"}</p>
      <div className="talk-tiles">
        {pages.items.map((v) => (
          <button
            key={v.id}
            className="tile talk-tile"
            aria-pressed={voice.voiceId === v.id}
            onClick={() => setVoice({ ...voice, voiceId: v.id })}
            data-dwell
          >
            <span className="tile-title">{v.name}</span>
            <span className="tile-check">
              <Icon name="check" />
            </span>
          </button>
        ))}
      </div>
      <BigPager label="Voices" {...pages} />
    </div>
  );
}
