import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

const AnnounceContext = createContext<(message: string, assertive?: boolean) => void>(() => undefined);

/** Screen-reader announcements (and optional speech) for status changes and selections. */
export function AnnouncerProvider({ children, speak }: { children: ReactNode; speak: boolean }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const counter = useRef(0);
  const announce = useCallback(
    (message: string, urgent = false) => {
      counter.current += 1;
      // A zero-width suffix makes repeated identical messages re-announce.
      const text = message + "​".repeat(counter.current % 2);
      if (urgent) setAssertive(text);
      else setPolite(text);
      if (speak && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(message));
      }
    },
    [speak],
  );
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="sr-only" role="status" aria-live="polite">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {assertive}
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce() {
  return useContext(AnnounceContext);
}
