/**
 * Telling the chosen carer, from My day, a care routine or a help tile. Nothing goes until the person has seen
 * exactly who gets what, and how, and looked again to confirm. One message, once; never a call, never an alert.
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import { carerSource, type CarerView, type Prepared, type RequestKind } from "./carer";
import { DayPage, LookToConfirm, PracticeNote, type DayTab } from "./parts";

/** Who the carer is and whether telling them is on. `null` while loading; `error` when it can't be known. */
export function useCarer(): { view: CarerView | null; error: string | null } {
  const [state, setState] = useState<{ view: CarerView | null; error: string | null }>({
    view: null,
    error: null,
  });
  useEffect(() => {
    let live = true;
    carerSource()
      .view()
      .then(
        (view) => live && setState({ view, error: null }),
        (err: unknown) =>
          live && setState({ view: null, error: err instanceof Error ? err.message : "Couldn't check." }),
      );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** The carer's name when telling them is on and someone is chosen, else null (the button isn't offered). */
export function carerName(view: CarerView | null): string | null {
  return view?.settings.notify_enabled && view.carer ? view.carer.name : null;
}

type Step =
  | { step: "preparing" }
  | { step: "confirm"; prepared: Prepared }
  | { step: "sending"; prepared: Prepared }
  | { step: "sent"; text: string }
  | { step: "failed"; text: string };

export function TellCarer({
  tab,
  kind,
  words,
  onDone,
}: {
  tab: DayTab;
  kind: RequestKind;
  words: string;
  /** `sent`: true when a message went; false when the person went back or it failed. */
  onDone: (sent: boolean) => void;
}) {
  const announce = useAnnounce();
  const [s, setS] = useState<Step>({ step: "preparing" });

  useEffect(() => {
    let live = true;
    carerSource()
      .prepare(kind, words)
      .then(
        (prepared) => live && setS({ step: "confirm", prepared }),
        (err: unknown) =>
          live &&
          setS({ step: "failed", text: err instanceof Error ? err.message : "Couldn't get that ready." }),
      );
    return () => {
      live = false;
    };
  }, [kind, words]);

  const cancel = () => {
    if (s.step === "confirm") void carerSource().cancel(s.prepared.ticket);
    onDone(false);
  };

  const send = async (prepared: Prepared) => {
    setS({ step: "sending", prepared });
    try {
      const r = await carerSource().send(prepared.ticket);
      const text =
        r.status === "failed"
          ? `It didn't reach ${r.to.name}: ${r.error ?? "the message failed"}. Nothing more was tried.`
          : r.simulated
            ? `Sent to ${r.to.name}'s practice phone. Nobody was really contacted.`
            : `Sent to ${r.to.name} by text message.`;
      announce(text);
      setS({ step: r.status === "failed" ? "failed" : "sent", text });
    } catch (err) {
      const text = err instanceof Error ? err.message : "It couldn't be sent.";
      announce(text);
      setS({ step: "failed", text });
    }
  };

  if (s.step === "confirm" || s.step === "sending") {
    const p = s.prepared;
    return (
      <DayPage tab={tab} title={`Send this to ${p.to.name}?`} bar={null}>
        <LookToConfirm
          question={`${p.to.name} gets one message, by ${p.to.how}.`}
          detail={
            <blockquote className="day-quote" data-testid="day-message">
              {p.body}
            </blockquote>
          }
          yes={`Send to ${p.to.name}`}
          busy={s.step === "sending"}
          onYes={() => void send(p)}
          onNo={cancel}
        />
        {p.to.simulated && <PracticeNote>Practice: this goes to a pretend phone.</PracticeNote>}
      </DayPage>
    );
  }

  const title = s.step === "preparing" ? "Getting it ready…" : s.text;
  return (
    <DayPage
      tab={tab}
      title={title}
      bar={
        s.step === "preparing" ? null : (
          <button
            className="btn btn-xl btn-primary"
            onClick={() => onDone(s.step === "sent")}
            data-dwell
            data-testid="day-tell-done"
          >
            <Icon name="check" /> {s.step === "sent" ? "Done" : "Back"}
          </button>
        )
      }
    >
      <span />
    </DayPage>
  );
}
