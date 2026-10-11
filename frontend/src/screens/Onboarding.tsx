/**
 * First-time setup, one idea per screen: what AGENCY is, the Mac permissions it needs (through the Mac app's
 * permission API), how the person will choose, and Lifeline. Best done with a helper; every step can be skipped
 * and done later from Settings.
 */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import type { PermissionKind, PermissionState, PermissionStatus } from "../state/contracts";
import { host } from "../state/host";
import { usePreferences } from "../state/preferences";
import { navigate } from "../state/router";
import { ONBOARDED_KEY } from "./Welcome";

const PERMISSIONS: { kind: PermissionKind; label: string; why: string }[] = [
  { kind: "camera", label: "Camera", why: "To follow your eyes. The video never leaves this Mac." },
  {
    kind: "accessibility",
    label: "Accessibility",
    why: "To press buttons in other apps when you look at them.",
  },
  {
    kind: "screen-recording",
    label: "Screen Recording",
    why: "So AGENCY can see the screen during a task you start.",
  },
  { kind: "microphone", label: "Microphone", why: "Only for calls, so you can hear and answer." },
];

const STEPS = ["welcome", "permissions", "input", "lifeline", "done"] as const;
type Step = (typeof STEPS)[number];

const STATE_TEXT: Record<PermissionState, string> = {
  granted: "Allowed",
  denied: "Not allowed: open System Settings to allow it",
  "not-determined": "Not asked yet",
};

function usePermissions(): {
  status: PermissionStatus | null;
  request: (k: PermissionKind) => void;
  open: (k: PermissionKind) => void;
} {
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const h = host();
  useEffect(() => {
    if (!h) return;
    void h.permissions
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    status,
    request: (k) => void h?.permissions.request(k).then(setStatus),
    open: (k) => void h?.permissions.openSettings(k),
  };
}

export function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]!);
  const prev = () => setStep(STEPS[Math.max(0, index - 1)]!);
  const finish = () => {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* ignore */
    }
    navigate("/");
  };

  return (
    <div className="flow onboarding" aria-label="Setting up AGENCY">
      <div className="flow-head">
        <div className="eyebrow">
          Setting up · step {index + 1} of {STEPS.length}
        </div>
        {step === "welcome" && <Welcome />}
        {step === "permissions" && <Permissions />}
        {step === "input" && <InputChoice onChosen={next} />}
        {step === "lifeline" && <LifelineStep />}
        {step === "done" && (
          <>
            <h1>You&apos;re ready</h1>
            <p className="muted">Everything here can be changed later in Settings.</p>
          </>
        )}
      </div>
      <div className="flow-bar" role="group" aria-label="Move around">
        {index > 0 && (
          <button className="btn btn-xl" onClick={prev} data-dwell>
            <Icon name="back" /> Back
          </button>
        )}
        <span className="spacer" />
        {step === "done" ? (
          <button className="btn btn-xl btn-primary" onClick={finish} data-dwell>
            <Icon name="home" /> Go to Home
          </button>
        ) : (
          <button className="btn btn-xl btn-primary" onClick={next} data-dwell>
            {step === "welcome" ? "Start" : "Next"} <Icon name="right" />
          </button>
        )}
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <>
      <h1>Welcome to AGENCY</h1>
      <div className="onboarding-points">
        <p>
          <Icon name="eye" /> Use your Mac with your eyes: look at something and hold your look to choose it.
        </p>
        <p>
          <Icon name="hand" /> AGENCY can do tasks for you, and always asks before anything important.
        </p>
        <p>
          <Icon name="bell" /> Help is always one look away: the red Help button is always at the left of the
          dock.
        </p>
      </div>
    </>
  );
}

function Permissions() {
  const { status, request, open } = usePermissions();
  const inApp = !!host();
  return (
    <>
      <h1>What AGENCY needs to work</h1>
      {!inApp && (
        <p className="muted">
          These are for the AGENCY Mac app. In this browser only the camera is used, and the browser asks when
          you start it.
        </p>
      )}
      <ul className="perm-list">
        {PERMISSIONS.map((p) => {
          const state = status?.[p.kind];
          return (
            <li key={p.kind} className="perm" data-state={state ?? "unknown"}>
              <span className="perm-text">
                <strong>{p.label}</strong>
                <span className="small muted">{p.why}</span>
                <span className="small">
                  {inApp ? (state ? STATE_TEXT[state] : "Checking…") : "Browser: not needed"}
                </span>
              </span>
              {inApp && state !== "granted" && (
                <button
                  className="btn btn-xl"
                  onClick={() => (state === "denied" ? open(p.kind) : request(p.kind))}
                  data-dwell
                >
                  {state === "denied" ? "Open System Settings" : "Allow"}
                </button>
              )}
              {state === "granted" && (
                <span className="badge" data-tone="ok">
                  <Icon name="check" size={18} /> Allowed
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function InputChoice({ onChosen }: { onChosen: () => void }) {
  const { prefs, update } = usePreferences();
  const choices = [
    {
      mode: "head" as const,
      label: "My eyes",
      sub: "The cursor follows your eyes. Hold to choose.",
      icon: "eye",
    },
    {
      mode: "scan_key" as const,
      label: "A switch",
      sub: "Choices light up one by one; press to pick.",
      icon: "key",
    },
    {
      mode: "pointer" as const,
      label: "Mouse or touch",
      sub: "For a helper, or if you can point.",
      icon: "pointer",
    },
  ];
  return (
    <>
      <h1>How will you choose things?</h1>
      <div className="flow-options" data-count={3} role="group" aria-label="Input">
        {choices.map((c) => (
          <button
            key={c.mode}
            className="choice"
            aria-pressed={prefs.input_mode === c.mode}
            onClick={() => {
              update({ input_mode: c.mode });
              if (c.mode === "head") navigate("/camera");
              else onChosen();
            }}
            data-dwell
          >
            <span className="choice-pic" aria-hidden>
              <Icon name={c.icon} size={44} />
            </span>
            <span className="choice-label">{c.label}</span>
            <span className="choice-sub">{c.sub}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function LifelineStep() {
  return (
    <>
      <h1>Who should AGENCY call if you need help?</h1>
      <p className="muted">
        Lifeline keeps contacting people until someone answers that they&apos;re coming. A helper can set up
        the contacts, the care plan and what they should know now, or later from Settings.
      </p>
      <div className="flow-options" data-count={2}>
        <button className="choice" onClick={() => navigate("/lifeline/setup")} data-dwell>
          <span className="choice-pic" aria-hidden>
            <Icon name="lifeline" size={44} />
          </span>
          <span className="choice-label">Set up Lifeline now</span>
          <span className="choice-sub">With a helper</span>
        </button>
        <button className="choice" onClick={() => navigate("/lifeline")} data-dwell>
          <span className="choice-pic" aria-hidden>
            <Icon name="shield" size={44} />
          </span>
          <span className="choice-label">See if Lifeline is ready</span>
          <span className="choice-sub">The readiness checklist</span>
        </button>
      </div>
    </>
  );
}
