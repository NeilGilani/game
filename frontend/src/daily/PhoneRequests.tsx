/**
 * On the simulated phones page (#/phones): the non-urgent requests My day sent to this contact, under Lifeline's
 * messages, so a demo shows where "Tell my carer" lands. Simulated messages only.
 */
import { clockTime } from "../lifeline/describe";
import { usePoll } from "../state/usePoll";
import { coordinatorCarer, type SentMessage } from "./carer";

export function PhoneRequests({ contactId }: { contactId: string }) {
  const poll = usePoll<SentMessage[]>(() => coordinatorCarer.messages(), 2000, "phones-daily");
  const mine = (poll.data ?? []).filter((m) => m.simulated && m.contact_id === contactId).slice(0, 4);
  if (mine.length === 0) return null;
  return (
    <div aria-label="Non-urgent requests from My day">
      <p className="small muted">Non-urgent requests</p>
      <ol>
        {mine.map((m) => (
          <li key={m.id} data-purpose="daily" data-testid="phone-request">
            <time>{clockTime(m.created_at)}</time>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
