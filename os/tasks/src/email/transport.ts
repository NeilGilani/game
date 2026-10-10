/**
 * Sending email with an attachment. Simulated by default (an outbox in memory). A real
 * transport goes through the person's own signed-in webmail via the AGENCY Bridge
 * (Instance 5), or Mail via agency-native, never with a password AGENCY holds.
 */

import { sha256Hex } from "../core/sha256";

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  attachment?: { name: string; bytes: Uint8Array };
}

export interface EmailTransport {
  readonly kind: "simulated" | "bridge";
  send(email: OutgoingEmail): Promise<{ messageId: string }>;
  /** Read back what was sent, to verify (sent folder or outbox). */
  find(messageId: string): Promise<{ to: string; subject: string; attachmentSha256?: string } | null>;
}

export class SimulatedEmail implements EmailTransport {
  readonly kind = "simulated" as const;
  readonly outbox: (OutgoingEmail & { messageId: string })[] = [];
  async send(email: OutgoingEmail): Promise<{ messageId: string }> {
    const messageId = `sim-mail-${this.outbox.length + 1}`;
    this.outbox.push({ ...email, messageId });
    return { messageId };
  }
  async find(messageId: string) {
    const m = this.outbox.find((o) => o.messageId === messageId);
    if (!m) return null;
    return {
      to: m.to,
      subject: m.subject,
      ...(m.attachment ? { attachmentSha256: sha256Hex(m.attachment.bytes) } : {}),
    };
  }
}
