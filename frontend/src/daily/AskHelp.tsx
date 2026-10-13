/**
 * Ask for help without alarm: "I'm cold", "turn me, please", "I need the bathroom". Each can be said out loud to
 * whoever is in the room, or (when the person turned it on) sent to their chosen carer after they see the exact
 * words. This is not Lifeline: nothing escalates, nobody is called, and the screen points to Help for emergencies.
 */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { readAloud } from "../papers/speak";
import { useAnnounce } from "../state/announcer";
import { BackButton, DayPage, HELP_REQUESTS, HomeButton, PracticeNote, type HelpRequestDef } from "./parts";
import { practiceMode } from "./store";
import { carerName, TellCarer, useCarer } from "./TellCarer";

export function AskHelp() {
  const announce = useAnnounce();
  const { view, error } = useCarer();
  const carer = carerName(view);
  const [chosen, setChosen] = useState<HelpRequestDef | null>(null);
  const [telling, setTelling] = useState(false);

  if (chosen && telling)
    return (
      <TellCarer
        tab="help"
        kind="help"
        words={chosen.words}
        onDone={() => {
          setTelling(false);
          setChosen(null);
        }}
      />
    );

  if (chosen) {
    const off = !carer;
    return (
      <DayPage
        tab="help"
        title={chosen.label}
        sub={`“${chosen.words}”`}
        bar={<BackButton label="Other requests" onBack={() => setChosen(null)} />}
      >
        <div className="flow-options" data-count={off ? 1 : 2} role="group" aria-labelledby="day-title">
          <button
            className="choice"
            onClick={() => {
              readAloud(chosen.words);
              announce(`Said out loud: ${chosen.words}`);
            }}
            data-dwell
          >
            <span className="choice-pic" aria-hidden>
              <Icon name="speak" size={44} />
            </span>
            <span className="choice-label">Say it out loud</span>
            <span className="choice-sub">For someone nearby</span>
          </button>
          {!off && (
            <button className="choice" onClick={() => setTelling(true)} data-dwell>
              <span className="choice-pic" aria-hidden>
                <Icon name="message" size={44} />
              </span>
              <span className="choice-label">Send to {carer}</span>
              <span className="choice-sub">You'll see the message first</span>
            </button>
          )}
        </div>
        {off && (
          <p className="day-empty muted">
            {error
              ? `Sending isn't available right now: ${error}`
              : "Sending to a carer is off. It can be turned on in Settings, For a helper, My day and home."}
          </p>
        )}
      </DayPage>
    );
  }

  return (
    <DayPage
      tab="help"
      title="Ask for help"
      sub="Not urgent. For an emergency, look at Help, the red button at the left of the dock."
      bar={<HomeButton />}
    >
      <div
        className="flow-options"
        data-count={HELP_REQUESTS.length}
        role="group"
        aria-label="What do you need?"
      >
        {HELP_REQUESTS.map((h) => (
          <button key={h.id} className="choice" onClick={() => setChosen(h)} data-dwell>
            <span className="choice-pic" aria-hidden>
              <Icon name={h.icon} size={44} />
            </span>
            <span className="choice-label">{h.label}</span>
          </button>
        ))}
      </div>
      {practiceMode() && <PracticeNote>Practice: requests go to a pretend phone.</PracticeNote>}
    </DayPage>
  );
}
