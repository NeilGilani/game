/**
 * The eye help signal (three long blinks) now lives in the gaze engine, @agency/gaze
 * (os/gaze/src/helpPattern.ts), which emits help-progress and help-signal events in AGENCY OS.
 * Re-exported here so Lifeline in the web app keeps working unchanged.
 */
export * from "../../../os/gaze/src/helpPattern";
