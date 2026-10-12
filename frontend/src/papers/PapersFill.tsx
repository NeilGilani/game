/**
 * Fill in a form, one box at a time: choose an answer from your saved details, type one with the eye keyboard, or
 * leave it empty. Then a review of every box, then a deliberate yes, and a new "...-filled.pdf" is saved next to the
 * original. Sending it is a helper's job: AGENCY doesn't send anything.
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { copyName, formSteps, type FieldStep } from "../../../os/tasks/src/documents/fields";
import { checkFilled, fillForm, fillableText, readForm } from "../../../os/tasks/src/documents/pdf/papers";
import { GateRefused } from "./gate";
import {
  Bar,
  Choice,
  Choices,
  Head,
  Message,
  PageButtons,
  Saved,
  SecondConfirm,
  type FlowProps,
} from "./parts";
import { fillProposal, shownValue } from "./plans";
import { plainError } from "./source";
import { loadDetails } from "./store";

type Stage =
  | { type: "loading" }
  | { type: "none"; why: string }
  | { type: "field"; index: number; typing: boolean; page: number }
  | { type: "review"; page: number }
  | { type: "confirm"; fp: string }
  | { type: "saving" }
  | { type: "saved"; name: string; where: string; count: number }
  | { type: "failed"; message: string };

const ROWS_PER_PAGE = 5;
const CHOICES_PER_PAGE = 4;

export function PapersFill({ doc, gate, source, onBack, onStop }: FlowProps) {
  const [steps, setSteps] = useState<FieldStep[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Stage>({ type: "loading" });
  const [fromReview, setFromReview] = useState(false);

  useEffect(() => {
    if (doc.kind !== "pdf") {
      setStage({ type: "none", why: "AGENCY can fill in PDF forms. This is a photo." });
      return;
    }
    readForm(doc.bytes).then(
      (fields) => {
        const s = formSteps(fields, loadDetails());
        setSteps(s);
        setAnswers(Object.fromEntries(s.map((x) => [x.field.name, x.field.value])));
        setStage(
          s.length
            ? { type: "field", index: 0, typing: false, page: 0 }
            : {
                type: "none",
                why: "This PDF has no boxes to fill in on screen. It may be a printed form; a helper can fill it in.",
              },
        );
      },
      (err: unknown) => setStage({ type: "none", why: plainError(err) }),
    );
  }, [doc]);

  const answer = (index: number, value: string) => {
    const step = steps[index]!;
    setAnswers((a) => ({ ...a, [step.field.name]: value }));
    next(index);
  };
  const next = (index: number) =>
    setStage(
      fromReview || index + 1 >= steps.length
        ? { type: "review", page: 0 }
        : { type: "field", index: index + 1, typing: false, page: 0 },
    );

  const save = async () => {
    const { proposal, values } = fillProposal(doc, steps, answers);
    setStage({ type: "saving" });
    try {
      const saved = await gate.perform(proposal, async () => {
        const out = await fillForm(doc.bytes, values);
        // Read the new copy back: every answer must be in it before it's saved.
        const missing = await checkFilled(out, values);
        if (missing.length)
          throw new Error(`Some answers didn't go in (${missing.join(", ")}), so nothing was saved.`);
        gate.check();
        return source.save(doc.name, "filled", out);
      });
      setStage({ type: "saved", ...saved, count: Object.keys(values).length });
    } catch (err) {
      if (gate.stopped) return;
      setStage({ type: "failed", message: err instanceof GateRefused ? err.message : plainError(err) });
    }
  };

  if (stage.type === "loading")
    return (
      <div className="flow" aria-label="Papers">
        <Head eyebrow="Fill in a form" title="Reading the form…" />
        <div className="flow-options flow-waiting" aria-busy="true" />
        <Bar onBack={onBack} />
      </div>
    );
  if (stage.type === "none")
    return (
      <Message eyebrow="Fill in a form" title="Nothing to fill in here" lines={[stage.why]} onBack={onBack} />
    );
  if (stage.type === "failed")
    return (
      <Message
        eyebrow="Fill in a form"
        title="Nothing was saved"
        lines={[stage.message]}
        onBack={() => setStage({ type: "review", page: 0 })}
      />
    );
  if (stage.type === "saved")
    return (
      <Saved
        title="Saved. A caregiver can send it."
        lines={[
          `Saved as "${stage.name}" ${stage.where}, with ${stage.count} answer${stage.count === 1 ? "" : "s"}.`,
          `The original "${doc.name}" stays as it was. Nothing was sent to anyone.`,
        ]}
      />
    );
  if (stage.type === "saving")
    return (
      <div className="flow" aria-label="Papers">
        <Head eyebrow="Fill in a form" title="Saving a filled copy…" />
        <div className="flow-options flow-waiting" aria-busy="true" />
        <Bar onBack={onBack} onStop={onStop} />
      </div>
    );

  if (stage.type === "review" || stage.type === "confirm") {
    const { proposal, values } = fillProposal(doc, steps, answers);
    const changed = Object.keys(values).length;
    const page = stage.type === "review" ? stage.page : 0;
    const pages = Math.max(1, Math.ceil(steps.length / ROWS_PER_PAGE));
    const rows = steps
      .map((s, i) => ({ s, i }))
      .slice(page * ROWS_PER_PAGE, page * ROWS_PER_PAGE + ROWS_PER_PAGE);
    const unsupported = Object.values(values).some((v) => fillableText(v) !== v.replace(/\n/g, " "));
    return (
      <div className="flow" aria-label="Papers" data-testid="papers-review">
        <Head
          eyebrow={`Fill in a form · "${doc.name}"`}
          title={stage.type === "confirm" ? "Save a filled copy?" : "Check every answer"}
          help={
            stage.type === "confirm"
              ? proposal.details["Saved as"]
              : `${changed} answer${changed === 1 ? "" : "s"} to put in. Look at each one; choose Change to fix it.${unsupported ? ' Some letters can\'t be shown in this form and will appear as "?".' : ""}`
          }
        />
        {stage.type === "confirm" ? (
          <SecondConfirm
            side="left"
            question={`Save "${copyName(doc.name, "filled")}" with these ${changed} answer${changed === 1 ? "" : "s"}?`}
            yes="Yes, save the copy"
            onNo={() => setStage({ type: "review", page: 0 })}
            onYes={() => {
              if (gate.approve(stage.fp)) void save();
            }}
          />
        ) : (
          <div className="stack">
            <dl className="papers-review" aria-label="Your answers">
              {rows.map(({ s, i }) => (
                <div key={s.field.name} className="papers-review-row">
                  <dt>{s.field.label}</dt>
                  <dd>{s.secret ? "Left for a helper" : shownValue(s, answers[s.field.name])}</dd>
                  {!s.secret && (
                    <button
                      className="btn"
                      onClick={() => {
                        setFromReview(true);
                        setStage({ type: "field", index: i, typing: false, page: 0 });
                      }}
                      data-dwell
                    >
                      <Icon name="edit" /> Change
                    </button>
                  )}
                </div>
              ))}
            </dl>
          </div>
        )}
        <Bar
          onBack={() => setStage({ type: "field", index: steps.length - 1, typing: false, page: 0 })}
          onStop={onStop}
        >
          {stage.type === "review" && (
            <>
              <PageButtons page={page} pages={pages} onPage={(p) => setStage({ type: "review", page: p })} />
              <button
                className="btn btn-xl btn-primary"
                disabled={changed === 0}
                onClick={() => setStage({ type: "confirm", fp: gate.propose(proposal) })}
                data-dwell
                data-approval-gate
              >
                <Icon name="check" /> Save a filled copy
              </button>
            </>
          )}
        </Bar>
      </div>
    );
  }

  const step = steps[stage.index]!;
  const f = step.field;
  const current = answers[f.name] ?? "";
  const back = () =>
    fromReview
      ? setStage({ type: "review", page: 0 })
      : stage.index === 0
        ? onBack()
        : setStage({ type: "field", index: stage.index - 1, typing: false, page: 0 });
  const eyebrow = `Fill in a form · Box ${stage.index + 1} of ${steps.length}${f.page !== undefined ? ` · page ${f.page + 1}` : ""}`;

  if (stage.typing)
    return (
      <div className="flow" aria-label="Papers">
        <Head eyebrow={eyebrow} title={f.label} />
        <TypeAnswer
          initial={current}
          maxLength={f.maxLength ?? 300}
          multiline={!!f.multiline}
          onDone={(v) => answer(stage.index, v)}
        />
        <Bar onBack={() => setStage({ ...stage, typing: false })} onStop={onStop} />
      </div>
    );

  // The choices for this box, from saved details only (never invented).
  const options: { key: string; label: string; sub?: string; icon: string; value?: string; type?: true }[] =
    [];
  if (step.secret) {
    // Nothing to choose: AGENCY never fills these.
  } else if (f.type === "checkbox") {
    options.push({ key: "yes", label: "Yes, tick it", icon: "check", value: "yes" });
    options.push({ key: "no", label: "No, leave it empty", icon: "x", value: "" });
  } else if (f.type === "choice") {
    for (const o of f.options ?? []) options.push({ key: `o-${o}`, label: o, icon: "check", value: o });
    options.push({ key: "empty", label: "Leave it empty", icon: "x", value: "" });
  } else {
    for (const s of step.suggestions)
      options.push({ key: `s-${s.value}`, label: s.value, sub: s.from, icon: "sparkle", value: s.value });
    if (current && !step.suggestions.some((s) => s.value === current))
      options.push({ key: "keep", label: current, sub: "What you typed", icon: "check", value: current });
    options.push({ key: "type", label: "Type it", sub: "With the keyboard", icon: "keyboard", type: true });
    options.push({ key: "empty", label: "Leave it empty", icon: "x", value: "" });
  }
  const pages = Math.max(1, Math.ceil(options.length / CHOICES_PER_PAGE));
  const shown = options.slice(
    stage.page * CHOICES_PER_PAGE,
    stage.page * CHOICES_PER_PAGE + CHOICES_PER_PAGE,
  );
  const help = step.secret
    ? "AGENCY never fills in passwords, card numbers or ID numbers. A helper can fill this box in later."
    : f.type === "text" && step.suggestions.length === 0
      ? "AGENCY has no saved detail for this, so it won't guess. Type it, or leave it empty."
      : current
        ? `Now: ${shownValue(step, current)}`
        : undefined;

  return (
    <div className="flow" aria-label="Papers" data-testid="papers-field">
      <Head eyebrow={eyebrow} title={f.label} help={help} />
      {step.secret ? (
        <Choices count={1}>
          <Choice
            label="Next box"
            sub="Leave this one for a helper"
            icon="right"
            onPick={() => next(stage.index)}
          />
        </Choices>
      ) : (
        <Choices count={shown.length}>
          {shown.map((o) => (
            <Choice
              key={o.key}
              label={o.label}
              sub={o.sub}
              icon={o.icon}
              onPick={() =>
                o.type ? setStage({ ...stage, typing: true }) : answer(stage.index, o.value ?? "")
              }
            />
          ))}
        </Choices>
      )}
      <Bar onBack={back} onStop={onStop}>
        <PageButtons page={stage.page} pages={pages} onPage={(p) => setStage({ ...stage, page: p })} />
      </Bar>
    </div>
  );
}

/** Typing an answer: the eye keyboard opens on the box (or a helper types). */
function TypeAnswer({
  initial,
  maxLength,
  multiline,
  onDone,
}: {
  initial: string;
  maxLength: number;
  multiline: boolean;
  onDone: (v: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <form
      className="flow-type"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(text.trim());
      }}
    >
      <label className="field">
        <span className="sr-only">Your answer</span>
        {multiline ? (
          <textarea
            value={text}
            maxLength={maxLength}
            rows={3}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <input value={text} maxLength={maxLength} autoFocus onChange={(e) => setText(e.target.value)} />
        )}
      </label>
      <p className="small muted">
        Type with the on-screen keyboard (Keyboard, on the eye-control bar) or a helper's keyboard.
      </p>
      <button className="btn btn-xl btn-primary" type="submit" disabled={!text.trim()} data-dwell>
        <Icon name="check" /> Done
      </button>
    </form>
  );
}
