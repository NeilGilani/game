/**
 * Explain a letter: say exactly what would be sent before anything is ("This letter's text will be sent to Gemini
 * to explain it. Nothing else."), then show what it is, who it's from, what they want, dates and amounts (each with
 * the line it came from) and what the person might do next, as big cards they can have read aloud.
 */
import { useState } from "react";
import { Icon } from "../components/Icon";
import {
  explanationSpeech,
  hasReadableText,
  letterText,
  type LetterExplanation,
  type QuotedFact,
} from "../../../os/tasks/src/documents/explain";
import { sha256Hex } from "../../../os/tasks/src/core/sha256";
import { explainLetter, type Explained } from "./explain";
import { GateRefused, type Proposal } from "./gate";
import { Bar, Choice, Choices, Head, Message, PageButtons, type FlowProps } from "./parts";
import { readAloud, stopReading } from "./speak";
import { cloudExplainAllowed } from "./store";

type Stage =
  | { type: "ask" }
  | { type: "working" }
  | { type: "done"; result: Explained }
  | { type: "failed"; message: string };

export function PapersExplain({ doc, gate, onBack, onStop }: FlowProps) {
  const { text, truncated } = letterText(doc.pages);
  const cloud = cloudExplainAllowed();
  const readable = hasReadableText(text);
  const proposal: Proposal = {
    kind: "explain",
    document: doc.name,
    documentSha256: doc.sha256,
    details: {
      "Sent to": "Google Gemini, through AGENCY's coordinator",
      "What is sent": `Only the letter's text: ${text.length.toLocaleString("en-US")} characters${truncated ? " (the start of a long letter)" : ""}`,
      "Text fingerprint": sha256Hex(text),
    },
  };
  // Without cloud explanation there is nothing to approve: nothing leaves this computer.
  const [stage, setStage] = useState<Stage>(() => ({ type: "ask" }));
  const [fp] = useState(() => (cloud && readable ? gate.propose(proposal) : ""));

  const run = async (useCloud: boolean) => {
    setStage({ type: "working" });
    try {
      const result = useCloud
        ? await gate.perform(proposal, (signal) => explainLetter(text, { cloud: true, signal }))
        : await explainLetter(text, { cloud: false, signal: gate.signal, reason: cloud ? "chosen" : "off" });
      if (!gate.stopped) setStage({ type: "done", result });
    } catch (err) {
      if (gate.stopped) return;
      setStage({
        type: "failed",
        message: err instanceof GateRefused ? err.message : "Something went wrong.",
      });
    }
  };

  if (!readable)
    return (
      <Message
        eyebrow="Explain a letter"
        title="AGENCY can't read the words in this one yet"
        lines={[
          doc.kind === "image"
            ? "It's a photo of a page, and AGENCY can't read words in photos yet."
            : "It looks like a scan: a picture of the page with no text inside the PDF.",
          "A helper can read it to you, or save it again as a PDF with text (most scanner apps can).",
        ]}
        onBack={onBack}
      />
    );
  if (stage.type === "failed")
    return <Message eyebrow="Explain a letter" title={stage.message} lines={[]} onBack={onBack} />;
  if (stage.type === "done") return <Explanation doc={doc.name} result={stage.result} onBack={onBack} />;
  if (stage.type === "working")
    return (
      <div className="flow" aria-label="Papers">
        <Head eyebrow="Explain a letter" title="Explaining it…" help={`"${doc.name}"`} />
        <div className="flow-options flow-waiting" aria-busy="true">
          <p className="muted">This takes a few seconds.</p>
        </div>
        <Bar onBack={onBack} onStop={onStop} />
      </div>
    );
  if (!cloud) {
    // A helper turned cloud explanation off: say so, and offer the basic version made here.
    return (
      <div className="flow" aria-label="Papers">
        <Head
          eyebrow="Explain a letter"
          title="AGENCY can find the basics on this computer"
          help="Explaining with Gemini is turned off in Settings. AGENCY can still find dates and amounts, with the lines they're in. Nothing is sent."
        />
        <Choices count={1}>
          <Choice
            label="Show me the basics"
            sub="Nothing leaves this computer"
            icon="info"
            onPick={() => void run(false)}
          />
        </Choices>
        <Bar onBack={onBack} />
      </div>
    );
  }
  return (
    <div className="flow" aria-label="Papers" data-testid="papers-consent">
      <Head
        eyebrow="Explain a letter"
        title="This letter's text will be sent to Gemini to explain it. Nothing else."
        help={`"${doc.name}": ${proposal.details["What is sent"]}. Not sent: the file itself, pictures of the pages, your saved details.`}
      />
      <Choices count={2}>
        <Choice
          label="Yes, explain it"
          sub="Send the text to Gemini"
          icon="sparkle"
          gate
          onPick={() => {
            if (gate.approve(fp)) void run(true);
          }}
        />
        <Choice
          label="Just the basics"
          sub="Send nothing. Dates and amounts found here"
          icon="shield"
          onPick={() => void run(false)}
        />
      </Choices>
      <Bar onBack={onBack} onStop={onStop} />
    </div>
  );
}

interface Card {
  title: string;
  body: string;
  quote?: string;
  list?: string[];
}

function cardsOf(e: LetterExplanation): Card[] {
  const cards: Card[] = [];
  if (e.what) cards.push({ title: "What it is", body: e.what });
  if (e.from)
    cards.push({ title: "Who it's from", body: e.from, ...(e.fromQuote ? { quote: e.fromQuote } : {}) });
  if (e.wants) cards.push({ title: "What they want", body: e.wants });
  const fact = (title: string) => (f: QuotedFact) => cards.push({ title, body: f.text, quote: f.quote });
  e.deadlines.forEach(fact(e.source === "basic" ? "Date" : "Deadline"));
  e.amounts.forEach(fact("Amount"));
  if (e.source === "basic" && !e.deadlines.length && !e.amounts.length)
    cards.push({
      title: "Dates and amounts",
      body: "AGENCY didn't find any dates or amounts of money in it.",
    });
  if (e.nextSteps.length) cards.push({ title: "What you might do next", body: "", list: e.nextSteps });
  return cards;
}

const CARDS_PER_PAGE = 3;

function Explanation({ doc, result, onBack }: { doc: string; result: Explained; onBack: () => void }) {
  const [page, setPage] = useState(0);
  const e = result.explanation;
  const cards = cardsOf(e);
  const pages = Math.max(1, Math.ceil(cards.length / CARDS_PER_PAGE));
  const shown = cards.slice(page * CARDS_PER_PAGE, page * CARDS_PER_PAGE + CARDS_PER_PAGE);
  const badge =
    e.source === "gemini"
      ? `Explained by ${result.label ?? "Gemini"}. Every date and amount was checked against the letter.`
      : "Basic: found on this computer by simple patterns, without AI. It may miss things.";
  return (
    <div className="flow" aria-label="Papers" data-testid="papers-explained">
      <Head
        eyebrow={`Explain a letter · "${doc}"`}
        title={e.source === "gemini" ? "What this letter says" : "The basics of this letter"}
        help={
          <>
            <span className="badge" data-tone={e.source === "gemini" ? "info" : "neutral"}>
              {badge}
            </span>{" "}
            {result.note}
            {e.dropped > 0 &&
              ` AGENCY left out ${e.dropped} thing${e.dropped === 1 ? "" : "s"} it couldn't find in the letter.`}
          </>
        }
      />
      <div className="papers-cards" data-count={shown.length}>
        {shown.map((c, i) => (
          <article key={`${page}-${i}`} className="papers-card">
            <h2>{c.title}</h2>
            {c.body && <p className="papers-card-body">{c.body}</p>}
            {c.list && (
              <ul>
                {c.list.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
            {c.quote && (
              <blockquote className="papers-quote">
                <span className="muted small">From the letter:</span> “{c.quote}”
              </blockquote>
            )}
          </article>
        ))}
      </div>
      <Bar
        onBack={() => {
          stopReading();
          onBack();
        }}
      >
        <button className="btn btn-xl" onClick={() => readAloud(explanationSpeech(e))} data-dwell>
          <Icon name="speak" /> Read aloud
        </button>
        <PageButtons page={page} pages={pages} onPage={setPage} />
      </Bar>
    </div>
  );
}
