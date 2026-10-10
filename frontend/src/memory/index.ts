/**
 * The memory tree in the interface. Other surfaces use:
 *   logSelection(event)              record what the person chose (never throws)
 *   useSuggestions(surface)          what to offer first, with reasons
 *   <UsualCard suggestion={...} />   "Usual Friday dinner ... Why: ... Keep / Forget"
 *   <MemoryExplorer segments={...}/> the "What AGENCY knows about me" screens (#/memory/...)
 *   FakeMemoryApi                    an in-memory stand-in for tests
 */
export { logSelection, memoryApi, type MemoryApi } from "./api";
export { FakeMemoryApi } from "./fake";
export { useSuggestions } from "./hooks";
export { MemoryApiProvider, MemoryExplorer, UsualCard, useMemoryApi } from "./MemoryExplorer";
export type * from "./types";
