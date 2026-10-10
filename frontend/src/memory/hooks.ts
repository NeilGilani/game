import { useEffect, useState } from "react";
import { memoryApi, type MemoryApi } from "./api";
import type { Suggestion, Surface } from "./types";

/**
 * Suggestions for a surface. Failures leave the list empty: a surface must work the same
 * without memory, it just doesn't offer anything first.
 */
export function useSuggestions(surface: Surface, limit = 6, client: MemoryApi = memoryApi, prefix?: string) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    client
      .suggestions(surface, limit, prefix)
      .then((s) => live && setItems(s))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [client, surface, limit, prefix, tick]);
  return { items, reload: () => setTick((t) => t + 1) };
}
