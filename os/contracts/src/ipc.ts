/** IPC channel names between the Electron main process, preload and renderers. */

export const CONTRACTS_VERSION = 0;

export const IPC = {
  /** main -> shell, overlay: GazeEvent */
  gaze: "agency:gaze",
  /** main -> overlay: TargetSnapshot (merged shell + ax + web) */
  targets: "agency:targets",
  /** renderer -> main (invoke): NativeMethods, only the subset the preload allows */
  native: "agency:native",
  /** renderer -> main: AgentCommand; main -> renderer: AgentEvent */
  agentCommand: "agency:agent-command",
  agentEvent: "agency:agent-event",
  /** any -> main: LifelineSignal */
  lifeline: "agency:lifeline",
  /** main -> overlay: show/hide modes (keyboard, numbers, zoom), protected targets */
  overlay: "agency:overlay",
  /** any -> main: stop all agent work and synthetic input now */
  stopAll: "agency:stop-all",
  // Added in v0 (additive), see host.ts.
  /** main -> renderers: NativeEvent */
  nativeEvent: "agency:native-event",
  /** shell -> main: its own Target[] in client coordinates */
  shellTargets: "agency:shell-targets",
  /** overlay -> main: true while the mouse is over the overlay's own targets */
  overlayInteractive: "agency:overlay-interactive",
  /** overlay -> main (invoke): OverlayDisplay for this window */
  overlayDisplay: "agency:overlay-display",
  /** renderer -> main (invoke): permissions status / request / openSettings */
  permissions: "agency:permissions",
  /** renderer -> main (invoke): HostStatus, onboarding state */
  host: "agency:host",
  /** overlay -> main: its clickable rects in global points (main toggles click-through from the cursor) */
  overlayRegions: "agency:overlay-regions",
  /** any -> main: bring the shell's Home to the front; main -> shell: show Home */
  showHome: "agency:show-home",
  /** shell, overlay -> main (invoke): memory suggestions and selection events, proxied to the coordinator */
  memory: "agency:memory",
  /** main -> gaze: frames per second to track at (slow while the shell, which tracks for itself, is in front) */
  gazePace: "agency:gaze-pace",
  /** shell -> main (invoke): real texts and calls through the person's iPhone (messaging.ts) */
  messaging: "agency:messaging",
  /** shell -> main (invoke): Papers, the person's documents in the one folder a helper chose (PapersApi) */
  papers: "agency:papers",
  /** shell -> main (invoke): AGENCY Browser (BrowserApi); main -> shell: BrowserEvent */
  browser: "agency:browser",
  browserEvent: "agency:browser-event",
  /** shell -> main (invoke): the home through Apple Shortcuts a helper set up (HomeApi, home.ts) */
  home: "agency:home",
  /** main -> a browser page's preload: a request; page -> main: its reply and its events (pages only) */
  page: "agency:page",
  pageReply: "agency:page-reply",
  pageEvent: "agency:page-event",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
