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
  const latestRequest = useRef(0);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const value = await fetcherRef.current();
      if (requestId !== latestRequest.current) return;
      setData(value);
      setError(null);
      setOffline(false);
    } catch (err) {
      if (requestId !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setOffline(err instanceof ApiError && err.offline);
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, []);

  const invalidate = useCallback(() => {
    latestRequest.current++;
  }, []);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError(null);
    setOffline(false);
    let timer: number | null = null;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await reload();
      if (!stopped) timer = window.setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      // A response from a prior page or poll must never replace newer evidence.
      invalidate();
      if (timer) window.clearTimeout(timer);
    };
  }, [key, intervalMs, reload, invalidate]);

  return { data, error, offline, loading, reload, set: setData };
}
