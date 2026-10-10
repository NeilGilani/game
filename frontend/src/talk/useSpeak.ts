import { useCallback, useEffect, useState } from "react";
import { pickVoice, type Voice } from "../../../os/tasks/src/index";
import { useAnnounce } from "../state/announcer";
import { useTalk } from "./services";
import { useHistory, useVoiceSettings } from "./storage";

/** Speak with the person's voice, remember it in history, and tell the memory tree. */
export function useSpeak() {
  const { speaker, memory } = useTalk();
  const { voice } = useVoiceSettings();
  const history = useHistory();
  const announce = useAnnounce();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    let live = true;
    speaker
      .voices()
      .then((v) => live && setVoices(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [speaker]);

  const chosen = pickVoice(voices, voice.voiceId, voice.usePersonalVoice);

  const speak = useCallback(
    async (text: string, opts: { remember?: boolean } = {}) => {
      const clean = text.trim();
      if (!clean) return false;
      setSpeaking(true);
      try {
        const ok = await speaker.say(clean, chosen ? { voiceId: chosen.id } : {});
        if (!ok) announce("The voice didn't work. Check the voice in Talk settings.", true);
        if (opts.remember !== false) {
          history.add(clean);
          void memory.log({ path: ["talk", clean], surface: "talk", outcome: "completed" });
        }
        return ok;
      } finally {
        setSpeaking(false);
      }
    },
    [speaker, chosen, history, memory, announce],
  );

  return { speak, speaking, voices, voice: chosen, kind: speaker.kind };
}
