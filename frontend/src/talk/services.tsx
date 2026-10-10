/**
 * What the Talk screens need from the rest of AGENCY, behind one context so the screens run
 * the same in the desktop app, the web app and tests:
 *  - a speaker (agency-native speech with Personal Voice in the app; Web Speech in a browser),
 *  - the memory tree (coordinator HTTP), never blocking when it's missing,
 *  - an agent that runs task packs (the in-process PackAgent on simulated backends until the
 *    real agent is wired through window.agency),
 *  - documents (a PDF engine is injected by the host; without one, Papers says so),
 *  - Lifeline's help request, passed in by the host so Talk never owns emergencies.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { NativeEvent } from "../../../os/contracts/src/native";
import {
  browserSpeaker,
  createFakeWorld,
  nativeSpeaker,
  safeMemory,
  httpMemory,
  type DocumentEngine,
  type FakeWorld,
  type MemoryClient,
  type NativeClient,
  type Speaker,
} from "../../../os/tasks/src/index";
import { accessToken, coordinatorUrl } from "../api/client";

export interface TalkServices {
  speaker: Speaker;
  memory: MemoryClient;
  world: FakeWorld;
  /** Present only in the desktop app: on-device listening for conversation mode. */
  native: NativeClient | null;
  engine: DocumentEngine | null;
  /** Start a Lifeline alert. Talk never contacts anyone itself. */
  requestHelp: () => void;
  /** Present only when the agent offers Claude reply suggestions (needs an API key and consent). */
  claudeReplies: ((request: string) => Promise<string[]>) | null;
  /** Everything Talk does with calls, ordering and email is simulated in this build. */
  simulated: true;
}

interface AgencyPreload {
  native?: {
    invoke: NativeClient["invoke"];
    onEvent?: (listener: (event: NativeEvent) => void) => () => void;
  };
}

function preload(): AgencyPreload | undefined {
  return (window as unknown as { agency?: AgencyPreload }).agency;
}

export function createDefaultServices(opts: {
  requestHelp: () => void;
  engine?: DocumentEngine | null;
  /** Overrides for tests and the harness. */
  speaker?: Speaker;
  memory?: MemoryClient;
  callDelayMs?: number;
}): TalkServices {
  const agency = preload();
  const native: NativeClient | null = agency?.native
    ? {
        invoke: agency.native.invoke,
        ...(agency.native.onEvent ? { onEvent: agency.native.onEvent } : {}),
      }
    : null;
  const speaker = opts.speaker ?? (native ? nativeSpeaker(native) : browserSpeaker());
  const memory =
    opts.memory ??
    safeMemory(
      httpMemory(coordinatorUrl(), (): Record<string, string> => {
        const token = accessToken();
        return token ? { "X-Agency-Token": token } : {};
      }),
    );
  const world = createFakeWorld({
    speaker,
    memory,
    callDelayMs: opts.callDelayMs ?? 700,
    ...(opts.engine ? { engine: opts.engine } : {}),
  });
  return {
    speaker,
    memory,
    world,
    native,
    engine: opts.engine ?? null,
    requestHelp: opts.requestHelp,
    claudeReplies: null,
    simulated: true,
  };
}

const TalkContext = createContext<TalkServices | null>(null);

export function TalkServicesProvider({
  services,
  children,
}: {
  services: TalkServices;
  children: ReactNode;
}) {
  return <TalkContext.Provider value={services}>{children}</TalkContext.Provider>;
}

export function useTalk(): TalkServices {
  const s = useContext(TalkContext);
  if (!s) throw new Error("Talk screens need a TalkServicesProvider");
  return s;
}
