import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../../../frontend/src/styles/app.css";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { InputLayer } from "../../../frontend/src/input/InputLayer";
import { AnnouncerProvider } from "../../../frontend/src/state/announcer";
import { ConnectionProvider } from "../../../frontend/src/state/connection";
import { InputProvider } from "../../../frontend/src/state/input";
import { PreferencesProvider } from "../../../frontend/src/state/preferences";
import { useRoute } from "../../../frontend/src/state/router";
import { TalkApp } from "../../../frontend/src/talk/TalkApp";
import {
  createDefaultServices,
  TalkServicesProvider,
  type TalkServices,
} from "../../../frontend/src/talk/services";
import { injectFrame, visionEngine } from "../../../frontend/src/vision/tracker";
import { createPdfEngine, type PdfJsLike } from "../src/documents/pdf/index";
import { SAMPLE_DOCUMENTS } from "../src/documents/pdf/samples";
import { FakeMemory } from "../src/memory/client";
import { encodeItems } from "../src/ordering/store";
import type { Speaker } from "../src/talk/speech";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface HarnessWindow {
  __talk: { spoken: string[]; help: number; services?: TalkServices };
  __agency?: { inject: (frame: Parameters<typeof injectFrame>[1]) => void };
}
const w = window as unknown as HarnessWindow;
w.__talk = { spoken: [], help: 0 };
w.__agency = { inject: (frame) => injectFrame(visionEngine(), frame) };

/** Records what would be spoken (headless browsers have no voices). */
const recordingSpeaker: Speaker = {
  kind: "fake",
  voices: async () => [
    { id: "harness.samantha", name: "Samantha (harness)", personal: false },
    { id: "harness.personal", name: "Riley (Personal Voice, harness)", personal: true },
  ],
  say: async (text) => {
    w.__talk.spoken.push(text);
    return true;
  },
};

const memory = new FakeMemory(
  {
    talk: [
      {
        nodeId: "m1",
        path: ["talk", "Please adjust my mask"],
        label: "Please adjust my mask",
        score: 0.9,
        reason: "You said this 9 times this week.",
      },
    ],
  },
  {
    "food/delivery/thai-basil": {
      nodeId: "m2",
      path: ["food", "delivery", "Thai Basil"],
      label: "Usual Friday dinner",
      score: 0.9,
      reason: "You chose this 4 of your last 5 Fridays.",
      task: {
        goal: "Order my usual",
        selections: {
          items: encodeItems([
            { itemId: "pad-thai", qty: 1, optionIds: ["mild"] },
            { itemId: "spring-rolls", qty: 1, optionIds: [] },
          ]),
        },
      },
    },
  },
);

function Harness() {
  const route = useRoute();
  const services = useMemo(
    () =>
      createDefaultServices({
        requestHelp: () => {
          w.__talk.help += 1;
        },
        engine: createPdfEngine(pdfjs as unknown as PdfJsLike),
        speaker: recordingSpeaker,
        memory,
        callDelayMs: 150,
      }),
    [],
  );
  w.__talk.services = services;
  const segments = route.segments[0] === "talk" ? route.segments.slice(1) : [];
  return (
    <TalkServicesProvider services={services}>
      <main className="main" id="main" tabIndex={-1}>
        <TalkApp segments={segments} samples={SAMPLE_DOCUMENTS} />
      </main>
      <InputLayer />
    </TalkServicesProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionProvider>
      <PreferencesProvider>
        <AnnouncerProvider speak={false}>
          <InputProvider>
            <Harness />
          </InputProvider>
        </AnnouncerProvider>
      </PreferencesProvider>
    </ConnectionProvider>
  </StrictMode>,
);
