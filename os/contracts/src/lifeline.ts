/**
 * Lifeline in the OS. The coordinator's API is the source of truth (backend/agency/lifeline, LIFELINE.md):
 *   POST /api/lifeline/help {source, test}     start an alert (never opens a second one)
 *   POST /api/lifeline/heartbeat {...}         the main process sends one every 5 s
 *   GET  /api/lifeline/status                  open alert, monitor, settings
 * Nothing in the OS may block, delay or hide Lifeline.
 */

export type HelpSource = "eye_signal" | "help_button" | "switch" | "test";

export type LifelineSignal =
  | { type: "lifeline.help"; source: HelpSource; test?: boolean }
  /** Bring the shell window to the front over everything, with the emergency screen. */
  | { type: "lifeline.surface" };
