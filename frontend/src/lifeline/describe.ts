/** Plain-language descriptions of Lifeline state, shared by the overlay and the screens. */

import type {
  AlertDetail,
  AlertSummary,
  LifelineContact,
  LifelineNotification,
  LifelineSettings,
} from "../api/types";

export const ROLE_LABEL: Record<string, string> = {
  caregiver: "caregiver",
  family: "family",
  neighbour: "neighbour",
  clinician: "clinician",
  monitoring_service: "monitoring service",
  other: "contact",
};

export const CHANNEL_LABEL: Record<string, string> = {
  demo: "Simulated phone (demo)",
  sms: "Text message",
  sms_call: "Text message and phone call",
};

export const KIND_LABEL: Record<string, string> = {
  help: "Help requested",
  watchdog: "Computer stopped responding",
  checkin_missed: "Check-in missed",
  signal_unavailable: "Eye signal unavailable",
  power_lost: "Ventilator power cut",
};

export const SOURCE_LABEL: Record<string, string> = {
  eye_signal: "three long blinks",
  help_button: "the Help button",
  switch: "a switch",
  test: "a test",
  watchdog: "the watchdog",
  checkin: "a missed check-in",
  device: "the ventilator's power watch",
};

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value < 90) return `${Math.round(value)} s`;
  return `${Math.floor(value / 60)} min ${Math.round(value % 60)} s`;
}

export function contactLabel(c: Pick<LifelineContact, "name" | "role">): string {
  return `${c.name} (${ROLE_LABEL[c.role] ?? "contact"})`;
}

/** Contacts grouped by priority: each group is one escalation level (mirrors the coordinator). */
export function levels(settings: LifelineSettings): LifelineContact[][] {
  const groups = new Map<number, LifelineContact[]>();
  for (const c of [...settings.contacts]
    .filter((c) => c.enabled)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))) {
    groups.set(c.priority, [...(groups.get(c.priority) ?? []), c]);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k)!);
}

export function names(list: { name: string }[]): string {
  const n = list.map((c) => c.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}

export type Tone = "ok" | "warn" | "danger" | "neutral" | "info";

/** The latest alert message per contact, with what we know about it. */
export function contactStates(alert: AlertDetail): { n: LifelineNotification; text: string; tone: Tone }[] {
  const latest = new Map<string, LifelineNotification>();
  for (const n of alert.notifications) if (n.purpose === "alert") latest.set(n.contact_id, n);
  const answered = new Map<string, LifelineNotification>();
  for (const n of alert.notifications) if (n.purpose === "alert" && n.response) answered.set(n.contact_id, n);
  return [...latest.values()].map((last) => {
    const n = answered.get(last.contact_id) ?? last;
    if (n.response === "acknowledged") return { n, text: "On the way", tone: "ok" as Tone };
    if (n.response === "declined") return { n, text: "Can't come", tone: "warn" as Tone };
    if (n.response === "resolved") return { n, text: "Ended the alert", tone: "ok" as Tone };
    if (n.status === "failed")
      return { n, text: `Couldn't reach. ${n.error ?? ""}`.trim(), tone: "danger" as Tone };
    if (n.status === "sending") return { n, text: "Sending…", tone: "neutral" as Tone };
    const how =
      n.channel === "demo"
        ? "on a simulated phone"
        : n.channel === "sms_call"
          ? "by text and call"
          : "by text";
    return { n, text: `Alert sent ${how}. Waiting for an answer.`, tone: "info" as Tone };
  });
}

/** What the coordinator will do next if nobody answers. */
export function nextStep(alert: AlertDetail, settings: LifelineSettings): string | null {
  if (alert.status !== "active" || alert.local_only || !alert.next_escalation_at) return null;
  const all = levels(settings);
  const at = clockTime(alert.next_escalation_at);
  const next = all[alert.level + 1];
  if (next && alert.cycle === 0) return `If no one answers by ${at}, AGENCY will contact ${names(next)}.`;
  return `If no one answers by ${at}, AGENCY will alert everyone again.`;
}

export function outcome(a: AlertSummary): { text: string; tone: Tone } {
  switch (a.status) {
    case "pending_cancel":
      return { text: "Counting down", tone: "warn" };
    case "active":
      return { text: a.local_only ? "Alarm only (no contacts)" : "Calling for help", tone: "danger" };
    case "acknowledged":
      return { text: `${a.acknowledged_by ?? "Someone"} on the way`, tone: "ok" };
    case "resolved":
      return { text: `Ended by ${a.resolved_by ?? "someone"}`, tone: "neutral" };
    case "cancelled":
      return { text: "Cancelled in countdown", tone: "neutral" };
  }
}
