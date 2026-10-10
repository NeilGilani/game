/**
 * The desktop host, when AGENCY runs inside the Mac app: `window.agency` from the preload script
 * (os/contracts/src/host.ts, Instance 1). In a plain browser, in tests and in development there is no host, and the
 * interface uses in-page fakes instead (state/fakeAgent.ts, state/native.ts), always labelled as simulated.
 *
 * Only the part of the host API the shell uses is declared here, matching host.ts.
 */
import type { AgentCommand, AgentEvent, AppInfo, PermissionKind, PermissionStatus } from "./contracts";

type Unsubscribe = () => void;

export interface ShellHost {
  readonly role: string;
  native: {
    call(method: "apps.list", params: { includeIcons?: boolean }): Promise<{ apps: AppInfo[] }>;
    call(method: "apps.launch", params: { bundleId: string }): Promise<{ ok: boolean; error?: string }>;
    call(method: "apps.activate", params: { bundleId: string }): Promise<{ ok: boolean }>;
    call(
      method: "speech.voices",
      params: Record<string, never>,
    ): Promise<{ voices: { id: string; name: string; personal: boolean }[] }>;
    call(
      method: "speech.say",
      params: { text: string; voiceId?: string; rate?: number },
    ): Promise<{ ok: boolean }>;
  };
  agent: {
    send(command: AgentCommand): void;
    onEvent(listener: (event: AgentEvent) => void): Unsubscribe;
  };
  stopAll(): Promise<unknown>;
  onStopAll(listener: () => void): Unsubscribe;
  permissions: {
    status(): Promise<PermissionStatus>;
    request(kind: PermissionKind): Promise<PermissionStatus>;
    openSettings(kind: PermissionKind): Promise<void>;
  };
}

/** The Mac app's host API, or null in a browser. Tests can force the fakes with `agency.fakes=host`. */
export function host(): ShellHost | null {
  try {
    if (localStorage.getItem("agency.fakes")?.split(",").includes("host")) return null;
  } catch {
    /* ignore */
  }
  const h = (window as unknown as { agency?: ShellHost }).agency;
  return h && typeof h.agent?.send === "function" ? h : null;
}

/** Is this fake forced for tests or demos? `localStorage["agency.fakes"] = "memory,agent"`. */
export function fakeForced(name: string): boolean {
  try {
    return !!localStorage.getItem("agency.fakes")?.split(",").includes(name);
  } catch {
    return false;
  }
}
