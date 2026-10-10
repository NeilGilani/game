/**
 * Home: a calm, Launchpad-style screen of big choices. Nothing on it moves while the person is looking: the
 * usuals row keeps its place while memory loads, there are no animations or tickers, and the layout fits one
 * screen at 1280 × 800 without scrolling.
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useLifeline } from "../lifeline/LifelineProvider";
import { useAgent } from "../state/agent";
import type { InputMode } from "../api/types";
import { MODE_LABELS, useInput } from "../state/input";
import type { Suggestion } from "../state/contracts";
import { memory } from "../state/memory";
import { navigate } from "../state/router";
import { isFinished, needsPerson, type TaskView } from "../state/tasks";

interface Tile {
  id: string;
  label: string;
  sub: string;
  icon: string;
  path: string;
  tone?: "lifeline";
}

export const HOME_TILES: Tile[] = [
  { id: "talk", label: "Talk", sub: "Say something out loud", icon: "speak", path: "/talk" },
  { id: "call", label: "Call someone", sub: "Jordan, Mom, the clinic", icon: "phone", path: "/flow/call" },
  { id: "food", label: "Food", sub: "Order a meal", icon: "food", path: "/flow/food" },
  { id: "messages", label: "Messages", sub: "Send a quick message", icon: "message", path: "/flow/messages" },
  { id: "watch", label: "Watch & listen", sub: "YouTube, Netflix, Music", icon: "play", path: "/flow/watch" },
  { id: "browse", label: "Browse", sub: "News, weather, the web", icon: "globe", path: "/flow/browse" },
  { id: "shopping", label: "Shopping", sub: "Compare and buy", icon: "bag", path: "/flow/shopping" },
  { id: "papers", label: "Papers", sub: "Letters, forms, signing", icon: "document", path: "/flow/papers" },
  { id: "apps", label: "Apps", sub: "Open or switch apps", icon: "grid", path: "/flow/apps" },
  { id: "errands", label: "Errands", sub: "Repairs, rides, cases", icon: "wrench", path: "/errands" },
  {
    id: "lifeline",
    label: "Lifeline",
    sub: "Help and Watch over me",
    icon: "lifeline",
    path: "/lifeline",
    tone: "lifeline",
  },
  { id: "settings", label: "Settings", sub: "Eyes, voice, memory", icon: "gear", path: "/settings" },
];

/** One plain sentence on how to choose, for the input the person is using now. */
export function howToChoose(mode: InputMode): string {
  if (mode === "gaze") return "Look at a choice until its ring fills.";
  if (mode === "head") return "Point with your head; hold still until the ring fills.";
  if (mode === "scan_blink") return "Choices light up in turn: close your eyes briefly on yours.";
  if (mode === "scan_key") return "Choices light up in turn: press Space on yours.";
  return "Click a choice, or use the keyboard.";
}

/** Eye control needs the camera on and a calibration; say so plainly, with one big way to fix it. */
function needsEyeSetup(input: ReturnType<typeof useInput>): boolean {
  if (!input.usesCamera) return false;
  return input.status === "off" || input.status === "error" || input.calibrationNeeded;
}

function EyeControlCard() {
  const input = useInput();
  if (!needsEyeSetup(input)) return null;
  const cameraOff = input.status === "off" || input.status === "error";
  const label = cameraOff ? "Turn on eye control" : "Teach AGENCY your eyes";
  const why = cameraOff
    ? `${MODE_LABELS[input.mode].short} needs the camera. It stays on this computer.`
    : "Follow a few dots with your eyes, about a minute. Until then the mouse works.";
  return (
    <button
      className="usual usual-continue home-setup"
      onClick={() => navigate(cameraOff ? "/camera" : "/calibrate")}
      data-dwell
      aria-label={`${label}. ${why}`}
    >
      <span className="usual-icon">
        <Icon name="eye" size={30} />
      </span>
      <span className="usual-text">
        <span className="usual-kicker">Start here</span>
        <span className="usual-title">{label}</span>
        <span className="usual-why">{why}</span>
      </span>
    </button>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const USUALS = 3;

/** Memory's suggestions for Home, loaded once. `null` while loading, so the row can hold its place. */
function useUsuals(): Suggestion[] | null {
  const [usuals, setUsuals] = useState<Suggestion[] | null>(null);
  useEffect(() => {
    let live = true;
    memory()
      .suggestions("home", USUALS)
      .then((s) => live && setUsuals(s.filter((x) => x.task).slice(0, USUALS)))
      .catch(() => live && setUsuals([]));
    return () => {
      live = false;
    };
  }, []);
  return usuals;
}

function continueText(t: TaskView): string {
  if (t.phase === "approval") return "Waiting for your OK";
  if (t.phase === "question") return "Waiting for your choice";
  if (t.phase === "paused") return "Paused";
  if (t.phase === "failed") return "Didn't finish: you can try again";
  return "Working on it";
}

export function Home() {
  const agent = useAgent();
  const input = useInput();
  const ll = useLifeline();
  const usuals = useUsuals();
  const unfinished = agent.tasks.filter((t) => !isFinished(t) || needsPerson(t));
  const resume = unfinished[0];
  const watching = !!ll.status?.monitor.armed;

  const startUsual = (s: Suggestion) => {
    if (!s.task) return;
    void memory().record({ path: s.path, surface: "home", outcome: "chosen" });
    const id = agent.start({ goal: s.task.goal, origin: "memory-suggestion", selections: s.task.selections });
    navigate(`/task/${id}`);
  };
  const open = (tile: Tile) => {
    void memory().record({ path: [tile.id], surface: "home", outcome: "chosen" });
    navigate(tile.path);
  };

  // Up to 3 usuals and one Continue card share the first row: 4 fixed slots.
  const fixed = (resume ? 1 : 0) + (needsEyeSetup(input) ? 1 : 0);
  const slots = (usuals ?? []).slice(0, Math.max(0, USUALS - fixed));

  return (
    <div className="home" aria-label="Home">
      <section className="widget home-widget" aria-labelledby="home-greeting">
        <div className="home-widget-head">
          <h1 id="home-greeting">{greeting()}.</h1>
          <p className="home-howto">
            {howToChoose(input.mode)} <strong>Help</strong> is the red button below.
          </p>
        </div>
        <p className="widget-sub">
          {memory().kind() === "demo" && usuals?.length ? "Your usuals (demo examples)" : "Your usuals"}
        </p>
        <div className="home-usuals" aria-label="Your usuals">
          <EyeControlCard />
          {resume && (
            <button
              className="usual usual-continue"
              onClick={() => navigate(`/task/${resume.id}`)}
              data-dwell
              aria-label={`Continue: ${resume.goal}. ${continueText(resume)}`}
            >
              <span className="usual-icon">
                <Icon name="resume" size={28} />
              </span>
              <span className="usual-text">
                <span className="usual-kicker">Continue</span>
                <span className="usual-title">{resume.goal}</span>
                <span className="usual-why">{continueText(resume)}</span>
              </span>
            </button>
          )}
          {usuals === null
            ? Array.from({ length: USUALS }, (_, i) => (
                <div key={i} className="usual usual-placeholder" aria-hidden />
              ))
            : slots.map((s) => (
                <button
                  key={s.nodeId}
                  className="usual"
                  onClick={() => startUsual(s)}
                  data-dwell
                  aria-label={`Your usual: ${s.label}. ${s.reason}`}
                >
                  <span className="usual-icon">
                    <Icon name="sparkle" size={28} />
                  </span>
                  <span className="usual-text">
                    <span className="usual-title">{s.label}</span>
                    <span className="usual-why">{s.reason}</span>
                  </span>
                </button>
              ))}
          {usuals?.length === 0 && !resume && !needsEyeSetup(input) && (
            <p className="usual-empty muted">
              As you use AGENCY, the things you choose most will appear here, with the reason.
            </p>
          )}
        </div>
      </section>

      <nav className="home-tiles" aria-label="Everything you can do">
        {HOME_TILES.map((tile) => (
          <button
            key={tile.id}
            className="home-tile"
            data-tone={tile.tone}
            data-tile={tile.id}
            onClick={() => open(tile)}
            data-dwell
            aria-label={`${tile.label}: ${tile.id === "lifeline" && watching ? "Watch over me is on" : tile.sub}`}
          >
            <span className="home-tile-icon" aria-hidden>
              <Icon name={tile.icon} size={52} />
            </span>
            <span className="home-tile-label">{tile.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
