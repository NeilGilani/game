/**
 * Talk and the communication screens, mounted by the shell at #/talk/... (Instance 1 or 7
 * adds the route; see os/tasks/INTEGRATION_REQUEST.md). Routes:
 *   /talk            word board          /talk/phrases[/id]  phrase boards
 *   /talk/listen     conversation mode   /talk/history       what I said
 *   /talk/voice      voice settings      /talk/emergency     emergency phrases + Lifeline
 *   /talk/call       call someone        /talk/papers        documents and signing
 *   /talk/shop       food and shopping
 */

import { Icon } from "../components/Icon";
import { navigate } from "../state/router";
import { Board } from "./Board";
import { Calls } from "./Calls";
import { Emergency } from "./Emergency";
import { History } from "./History";
import { Listen } from "./Listen";
import { Papers, type SampleDoc } from "./Papers";
import { PhraseBoardView, PhraseBoards } from "./Phrases";
import { Shop } from "./Shop";
import { VoiceSettings } from "./VoiceSettings";
import "./talk.css";

const TABS: { path: string; label: string; icon: string }[] = [
  { path: "", label: "Words", icon: "message" },
  { path: "phrases", label: "Phrases", icon: "list" },
  { path: "listen", label: "Listen", icon: "eye" },
  { path: "history", label: "History", icon: "timeline" },
  { path: "voice", label: "Voice", icon: "gear" },
];

const TITLES: Record<string, string> = {
  "": "Say something",
  phrases: "Phrases",
  listen: "Conversation",
  history: "What I said",
  voice: "My voice",
  emergency: "Emergency",
};

/** `segments` are the route segments after "talk". */
export function TalkApp({ segments, samples }: { segments: string[]; samples?: SampleDoc[] }) {
  const [a = "", b] = segments;
  if (a === "call") return <Calls />;
  if (a === "papers") return <Papers samples={samples ?? []} />;
  if (a === "shop") return <Shop />;

  let body;
  if (a === "") body = <Board />;
  else if (a === "phrases" && b) body = <PhraseBoardView key={b} id={b} />;
  else if (a === "phrases") body = <PhraseBoards />;
  else if (a === "listen") body = <Listen />;
  else if (a === "history") body = <History />;
  else if (a === "voice") body = <VoiceSettings />;
  else if (a === "emergency") body = <Emergency />;
  else body = <p>That page doesn't exist.</p>;

  return (
    <div className="page talk-page" aria-label="Talk">
      <nav className="talk-tabs" aria-label="Talk">
        {TABS.map((t) => (
          <button
            key={t.path}
            className="talk-tab"
            aria-current={a === t.path ? "page" : undefined}
            onClick={() => navigate(t.path ? `/talk/${t.path}` : "/talk")}
            data-dwell
          >
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
        <button
          className="talk-tab talk-tab-urgent"
          aria-current={a === "emergency" ? "page" : undefined}
          onClick={() => navigate("/talk/emergency")}
          data-dwell
        >
          <Icon name="alert" /> Emergency
        </button>
      </nav>
      <h1 className="sr-only">{TITLES[a] ?? "Talk"}</h1>
      {body}
    </div>
  );
}
