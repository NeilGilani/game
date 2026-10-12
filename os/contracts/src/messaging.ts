/**
 * Real texts and calls through the person's own iPhone: the Mac's Messages app (iMessage, or text messages through
 * the iPhone's Text Message Forwarding) and iPhone calls handed to the Mac (Continuity). Added in v0 (additive).
 *
 * Only the main process sends anything. The shell asks it in two steps: `prepare` turns a saved person and exact
 * words into a ticket with a fingerprint (shown on the approval screen), and `send` sends exactly that ticket once,
 * only with the same fingerprint. Main looks up the phone number itself from the person's saved people; a renderer
 * never passes a number.
 */

/** How texts go: iMessage (falls back to a text message through the iPhone when there is no iMessage), or always a text message. */
export type TextVia = "auto" | "sms";
/** How calls go: a phone call through the iPhone (tel:), or FaceTime audio. */
export type CallVia = "phone" | "facetime";

export interface MessagingSettings {
  /** Off until the person or a helper turns it on in Settings. */
  enabled: boolean;
  textVia: TextVia;
  callVia: CallVia;
}

/** One of the person's saved people with a real phone number (Lifeline contacts). The number stays in main. */
export interface RealPerson {
  id: string;
  name: string;
  role: string;
  /** The number for showing on the approval, e.g. "+1 (415) 555-0123". */
  display: string;
}

export interface MessagingStatus {
  /** Real texts and calls can work here (the Mac app on macOS). */
  available: boolean;
  /** Why not, in plain words, when `available` is false. */
  reason?: string;
  settings: MessagingSettings;
  /** Empty while turned off. */
  people: RealPerson[];
}

export type PrepareRequest =
  | { kind: "text"; contactId: string; text: string }
  /** `textFirst` sends AGENCY's fixed note ("I'm calling you through AGENCY...") before the call. */
  | { kind: "call"; contactId: string; textFirst: boolean };

export type PrepareResult =
  | {
      ok: true;
      ticket: string;
      /** The approval counts only with this fingerprint. */
      fingerprint: string;
      kind: "text" | "call";
      person: RealPerson;
      /** The exact words of the text, or of the note sent before a call (null: no note). */
      text: string | null;
      via: TextVia | CallVia;
    }
  | { ok: false; error: string };

export type SendResult =
  | {
      ok: true;
      /** "imessage" or "sms" for a text; "phone" or "facetime" for a call. */
      via: string;
      /** A call's note that couldn't be sent (the call was still placed), in plain words. */
      warning?: string;
    }
  | { ok: false; error: string };

export interface MessagingCheck {
  imessage: boolean;
  sms: boolean;
  /** Plain words for the person or a helper. */
  message: string;
}

/** `window.agency.messaging` (shell only). */
export interface MessagingApi {
  status(): Promise<MessagingStatus>;
  setSettings(settings: Partial<MessagingSettings>): Promise<MessagingStatus>;
  /** Asks Messages which services it has, without sending anything (shows the macOS Automation prompt once). */
  check(): Promise<MessagingCheck>;
  prepare(request: PrepareRequest): Promise<PrepareResult>;
  send(ticket: string, fingerprint: string): Promise<SendResult>;
  /** Forget a ticket that wasn't approved. */
  cancel(ticket: string): Promise<void>;
}
