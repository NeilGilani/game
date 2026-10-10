/**
 * Phone calls in which the person speaks through text-to-speech. A transport places the call,
 * sends synthesized speech as the outgoing audio and delivers the other party's words as
 * on-device transcripts. The simulator is the default; Twilio Voice is used only when
 * configured, and every call still needs an approval of the exact number.
 */

export type CallState = "dialing" | "ringing" | "connected" | "ended" | "failed";

export interface RemoteLine {
  text: string;
  /** Partial transcripts may change; only final lines get reply suggestions. */
  final: boolean;
  /** Script-provided reply suggestions (simulator only). */
  suggestions?: string[];
}

export interface CallSession {
  readonly id: string;
  readonly to: string;
  readonly simulated: boolean;
  readonly state: CallState;
  /** Speak into the call with the person's text-to-speech voice. */
  say(text: string): Promise<void>;
  onRemote(listener: (line: RemoteLine) => void): () => void;
  onState(listener: (state: CallState, reason?: string) => void): () => void;
  hangUp(): Promise<void>;
}

export interface DialOptions {
  /** Spoken first, before anything else, every call. */
  disclosure: string;
  /** Recording is off by default and nothing in this package records. */
  record: false;
}

export interface CallTransport {
  readonly kind: "simulated" | "twilio";
  dial(e164: string, options: DialOptions): Promise<CallSession>;
}

export interface Disclosure {
  personName: string;
  mode: "tts" | "ai-assistant";
  /** For agent-assisted calls: what the assistant may agree to. */
  purpose?: string;
}

export function disclosureText({ personName, mode, purpose }: Disclosure): string {
  if (mode === "ai-assistant")
    return `Hello. This is an AI assistant calling on behalf of ${personName}, who can't speak. ${purpose ? `I'm calling to ${purpose}. ` : ""}I can only agree to what ${personName} has approved, and ${personName} can take over at any time. This call is not recorded.`;
  return `Hello. This call uses a text-to-speech voice for ${personName}, who can't speak. ${personName} is choosing every word with their eyes, so replies may take a moment. This call is not recorded.`;
}
