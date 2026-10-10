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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
