/** Every task pack, built from its dependencies. The agent registers these in its pack tier. */

import type { TaskPack } from "../core/pack";
import { createCallPack, type CallPackDeps } from "./call";
import { createDocumentsPack, type DocumentsPackDeps } from "./documents";
import { createOrderingPack, type OrderingPackDeps } from "./ordering";
import { createTalkPack, type TalkPackDeps } from "./talk";

export interface AllPackDeps {
  talk: TalkPackDeps;
  call: CallPackDeps;
  documents: DocumentsPackDeps;
  ordering: OrderingPackDeps;
}

export function createPacks(deps: AllPackDeps): TaskPack[] {
  return [
    createTalkPack(deps.talk),
    createCallPack(deps.call),
    createDocumentsPack(deps.documents),
    createOrderingPack(deps.ordering),
  ];
}

export { createCallPack, createDocumentsPack, createOrderingPack, createTalkPack };
