import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, coordinatorUrl } from "../api/client";
import type { Health } from "../api/types";

export interface ConnectionState {
  health: Health | null;
  online: boolean;
  /** True until the first health check finishes. */
  checking: boolean;
  error: string | null;
  authProblem: boolean;
  address: string;
  lastSeen: number | null;
  refresh: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [online, setOnline] = useState(true);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authProblem, setAuthProblem] = useState(false);
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      setOnline(true);
      setError(null);
      setLastSeen(Date.now());
      if (h.auth_required) {
        try {
          await api.cases("active");
          setAuthProblem(false);
        } catch (err) {
          setAuthProblem(err instanceof ApiError && err.status === 401);
        }
      } else {
        setAuthProblem(false);
      }
    } catch (err) {
      setOnline(false);
      setError(err instanceof Error ? err.message : "Can't reach the coordinator.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      await refresh();
      if (!cancelled) timer.current = window.setTimeout(tick, online ? 4000 : 2000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [refresh, online]);

  const value: ConnectionState = {
    health,
    online,
    checking,
    error,
    authProblem,
    address: coordinatorUrl() || window.location.origin,
    lastSeen,
    refresh,
  };
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionState {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error("useConnection outside ConnectionProvider");
  return ctx;
}

export function coordinatorLabel(health: Health | null, online: boolean): { short: string; long: string } {
  if (!online) return { short: "Coordinator offline", long: "Can't reach the coordinator" };
  if (!health) return { short: "Connecting…", long: "Connecting to the coordinator" };
  if (health.node.is_raspberry_pi || health.node.role === "raspberry-pi") {
    return {
      short: "Raspberry Pi",
      long: `Connected to the Raspberry Pi coordinator (${health.node.hostname}${health.node.device_model ? `, ${health.node.device_model}` : ""})`,
    };
  }
  return { short: "This MacBook", long: `Running locally on this computer (${health.node.hostname})` };
}
