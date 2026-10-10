/** Talk inside the shell (#/talk/...): Instance 8's TalkApp with real services and the PDF engine. */

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useMemo } from "react";
import { createPdfEngine, type PdfJsLike } from "../../../os/tasks/src/documents/pdf/index";
import { SAMPLE_DOCUMENTS } from "../../../os/tasks/src/documents/pdf/samples";
import { useLifeline } from "../lifeline/LifelineProvider";
import { createDefaultServices, TalkServicesProvider } from "./services";
import { TalkApp } from "./TalkApp";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function TalkRoute({ segments }: { segments: string[] }) {
  const lifeline = useLifeline();
  const services = useMemo(
    () =>
      createDefaultServices({
        requestHelp: () => void lifeline.requestHelp("help_button"),
        engine: createPdfEngine(pdfjs as unknown as PdfJsLike),
      }),
    // The services live as long as the Talk screen; Lifeline's identity doesn't change while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return (
    <TalkServicesProvider services={services}>
      <TalkApp segments={segments} samples={SAMPLE_DOCUMENTS} />
    </TalkServicesProvider>
  );
}
