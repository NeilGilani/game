import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export interface Poll<T> {
  data: T | null;
  error: string | null;
  offline: boolean;
  loading: boolean;
  reload: () => Promise<void>;
  set: (value: T) => void;
}

/** Fetch now, then every `intervalMs` (paused while the tab is hidden). */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, key: string): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    try {
      const value = await fetcherRef.current();
      setData(value);
      setError(null);
      setOffline(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setOffline(err instanceof ApiError && err.offline);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setData(null);
    let timer: number | null = null;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await reload();
      if (!stopped) timer = window.setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [key, intervalMs, reload]);

  return { data, error, offline, loading, reload, set: setData };
}
