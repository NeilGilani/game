/**
 * Simulated phones for the Lifeline demo, in their own window (#/phones).
 *
 * This page stands in for the contacts' real phones, so it deliberately runs none of the
 * person's machinery: no camera, no alarm, no heartbeat, no emergency overlay. The response
 * links are real and open the same page a contact's phone would.
 */

import { lifelineApi, respondUrl } from "../api/client";
import type { LifelineStatus, OutboxMessage } from "../api/types";
import { Icon } from "../components/Icon";
import { QrCode } from "../components/QrCode";
import { ErrorNote } from "../components/common";
import { SimulatedBadge } from "../components/status";
import { clockTime, contactLabel } from "../lifeline/describe";
import { usePoll } from "../state/usePoll";

export function PhoneSimulator() {
  const status = usePoll<LifelineStatus>(() => lifelineApi.status(), 2000, "phones-status");
  const outbox = usePoll<{ messages: OutboxMessage[] }>(() => lifelineApi.outbox(), 1500, "phones-outbox");
  const contacts = status.data?.settings.contacts.filter((c) => c.channel === "demo") ?? [];
  const publicUrl = status.data?.channels.public_url ?? "";
  // Phones can only open links that point at an address on the network, not at this computer.
  const phonesCanReach = !!publicUrl && !/\/\/(localhost|127\.|\[::1\])/.test(publicUrl);
  const byContact = new Map<string, OutboxMessage[]>();
  for (const m of outbox.data?.messages ?? []) {
    byContact.set(m.contact_id, [...(byContact.get(m.contact_id) ?? []), m]);
  }
  return (
    <div className="phones-page">
      <header className="phones-head">
        <div>
          <div className="eyebrow">AGENCY Lifeline demo</div>
          <h1>Simulated phones</h1>
          <p>
            In the demo, alerts go to these simulated phones instead of real ones. The links are real: open
            one to answer as that person, here or on any phone that can reach the coordinator.
          </p>
        </div>
        <SimulatedBadge text="Nobody real is contacted" />
      </header>
      {status.data && (
        <p className="panel panel-muted small">
          {phonesCanReach
            ? `Scan a code with a real phone on the same network to answer from it. Links point to ${publicUrl}.`
            : `To answer from a real phone, the coordinator must be reachable on your network (for example on the Raspberry Pi, see DEPLOY_PI.md). Response links currently point to ${publicUrl}, which only this computer can open.`}
        </p>
      )}
      {(outbox.error || status.error) && (
        <ErrorNote message={outbox.error ?? status.error ?? ""} onRetry={() => void outbox.reload()} />
      )}
      <div className="ll-phones">
        {contacts.map((c) => {
          const msgs = byContact.get(c.id) ?? [];
          return (
            <section className="ll-phone" key={c.id} aria-label={`${c.name}'s simulated phone`}>
              <header>
                <Icon name="phone" />
                <strong>{contactLabel(c)}</strong>
              </header>
              {msgs.length === 0 ? (
                <p className="small muted">No messages.</p>
              ) : (
                <ol>
                  {msgs.slice(0, 6).map((m) => (
                    <li key={m.id} data-purpose={m.purpose}>
                      <time>{clockTime(m.created_at)}</time>
                      <p>{m.body.replace(/ Respond here: \S+$/, "")}</p>
                      {m.link && m.alert_status !== "resolved" && m.alert_status !== "cancelled" ? (
                        <>
                          <a
                            className="btn btn-primary"
                            href={respondUrl(m.link)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open as {c.name}
                          </a>
                          {phonesCanReach && (
                            <QrCode
                              value={`${publicUrl}${m.link}`}
                              label={`QR code: open ${c.name}'s response link on a phone`}
                            />
                          )}
                        </>
                      ) : m.response ? (
                        <span className="badge" data-tone="ok">
                          Answered: {m.response === "acknowledged" ? "on the way" : m.response}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          );
        })}
        {status.data && contacts.length === 0 && <p className="empty">No contacts use a simulated phone.</p>}
      </div>
    </div>
  );
}
