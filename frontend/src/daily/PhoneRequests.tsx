/**
 * Everyday requests on a simulated phone (the "Simulated phones" window), with their real reply links. Separate from
 * Lifeline's alerts on purpose: they are labelled "not an emergency".
 */
import { useEffect, useState } from "react";
import { accessToken, coordinatorUrl, respondUrl } from "../api/client";
import { clockTime } from "../lifeline/describe";

interface Message {
  id: string;
  contact_id: string;
  body: string;
  created_at: string;
  reply: string | null;
  link: string;
}

const REPLY: Record<string, string> = {
  coming: "On my way",
  soon: "In a few minutes",
  cant: "Can't come right now",
};

/** Polls the coordinator's daily outbox (shared by every phone on the page). */
function useOutbox(): Message[] {
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const headers: Record<string, string> = {};
        const token = accessToken();
        if (token) headers["X-Agency-Token"] = token;
        const r = await fetch(`${coordinatorUrl()}/api/daily/outbox`, { headers });
        if (r.ok && !stopped) setMessages(((await r.json()) as { messages: Message[] }).messages);
      } catch {
        /* the phones page shows Lifeline's own connection errors */
      }
      if (!stopped) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return messages;
}

/** Requests to one simulated phone. */
export function PhoneRequests({ contactId }: { contactId: string }) {
  const mine = useOutbox()
    .filter((m) => m.contact_id === contactId)
    .slice(0, 4);
  if (!mine.length) return null;
  return (
    <div className="day-phone-requests" data-testid={`phone-requests-${contactId}`}>
      <p className="small">
        <strong>Everyday requests (not emergencies)</strong>
      </p>
      <ol>
        {mine.map((m) => (
          <li key={m.id}>
            <time>{clockTime(m.created_at)}</time>
            <p>{m.body.replace(/ Reply here: \S+$/, "")}</p>
            {m.reply ? (
              <p className="small">Answered: {REPLY[m.reply] ?? m.reply}</p>
            ) : (
              <a className="btn" href={respondUrl(m.link)} target="_blank" rel="noopener noreferrer">
                Answer as this person
              </a>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
