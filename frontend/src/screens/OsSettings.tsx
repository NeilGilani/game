/**
 * Settings as big choices (input, calibration, voice, memory, Lifeline, caregiver), plus the voice and memory
 * screens, and Talk's place on Home until the Talk screen (frontend/src/talk) lands.
 */
import { useEffect, useState, type ReactNode } from "react";
import { accessToken, coordinatorUrl } from "../api/client";
import { ConfirmSheet, SELECTION_RESET_EVENT } from "../components/common";
import { Icon } from "../components/Icon";
import { useAnnounce } from "../state/announcer";
import type { Suggestion } from "../state/contracts";
import { host } from "../state/host";
import { memory } from "../state/memory";
import { navigate } from "../state/router";

interface Choice {
  id: string;
  label: string;
  sub: string;
  icon: string;
  path: string;
}

const SETTINGS: Choice[] = [
  {
    id: "input",
    label: "How you choose",
    sub: "Eyes, switch, mouse; dwell time; text size; theme",
    icon: "eye",
    path: "/preferences",
  },
  {
    id: "calibrate",
    label: "Calibrate my eyes",
    sub: "Camera check, then follow the dots",
    icon: "target",
    path: "/camera",
  },
  {
    id: "voice",
    label: "Voice",
    sub: "The voice that speaks for you",
    icon: "speak",
    path: "/settings/voice",
  },
  {
    id: "memory",
    label: "What AGENCY remembers",
    sub: "See, change or erase it",
    icon: "sparkle",
    path: "/settings/memory",
  },
  {
    id: "lifeline",
    label: "Lifeline",
    sub: "Contacts, care plan, emergency services",
    icon: "lifeline",
    path: "/lifeline/setup",
  },
  {
    id: "caregiver",
    label: "For a helper",
    sub: "Connection, status, setup again",
    icon: "wrench",
    path: "/settings/helper",
  },
];

function ChoiceGrid({ items, label }: { items: Choice[]; label: string }) {
  return (
    <nav className="flow-options" data-count={items.length} aria-label={label}>
      {items.map((c) => (
        <button key={c.id} className="choice" onClick={() => navigate(c.path)} data-dwell>
          <span className="choice-pic" aria-hidden>
            <Icon name={c.icon} size={44} />
          </span>
          <span className="choice-label">{c.label}</span>
          <span className="choice-sub">{c.sub}</span>
        </button>
      ))}
    </nav>
  );
}

function Bar({ backTo, children }: { backTo: string; children?: ReactNode }) {
  return (
    <div className="flow-bar" role="group" aria-label="Move around">
      <button className="btn btn-xl" onClick={() => navigate(backTo)} data-dwell>
        <Icon name="back" /> Back
      </button>
      <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
        <Icon name="home" /> Home
      </button>
      {children}
    </div>
  );
}

export function SettingsHub() {
  const [page, setPage] = useState(0);
  const announce = useAnnounce();
  const pageSize = 5;
  const pageCount = Math.ceil(SETTINGS.length / pageSize);
  const changePage = () => {
    const next = page === 0 ? 1 : 0;
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    setPage(next);
    announce(`Settings page ${next + 1} of ${pageCount}.`);
    document.getElementById("settings-heading")?.focus({ preventScroll: true });
  };
  return (
    <div className="flow" aria-label="Settings">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="gear" size={18} /> Settings · {page + 1} of {pageCount}
        </div>
        <h1 id="settings-heading" tabIndex={-1}>
          What would you like to change?
        </h1>
      </div>
      <ChoiceGrid items={SETTINGS.slice(page * pageSize, (page + 1) * pageSize)} label="Settings" />
      <Bar backTo="/">
        <button className="btn btn-xl settings-page" onClick={changePage} data-dwell>
          {page === 0 ? "More settings" : "Previous settings"}
          <Icon name={page === 0 ? "right" : "left"} />
        </button>
      </Bar>
    </div>
  );
}

export function HelperSettings() {
  const items: Choice[] = [
    {
      id: "connection",
      label: "Coordinator connection",
      sub: "Address and access token",
      icon: "laptop",
      path: "/settings/connection",
    },
    {
      id: "status",
      label: "Status and demo controls",
      sub: "What's running, reset the demo",
      icon: "info",
      path: "/status",
    },
    {
      id: "onboarding",
      label: "Set up again",
      sub: "Permissions, input, Lifeline",
      icon: "refresh",
      path: "/onboarding",
    },
    {
      id: "cases",
      label: "Cases and approvals",
      sub: "Every errand and decision",
      icon: "list",
      path: "/cases",
    },
  ];
  return (
    <div className="flow" aria-label="For a helper">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="gear" size={18} /> Settings
        </div>
        <h1>For a helper</h1>
        <p className="muted">These are easiest with a keyboard and mouse.</p>
      </div>
      <ChoiceGrid items={items} label="Helper settings" />
      <Bar backTo="/settings" />
    </div>
  );
}

// ---- Voice ------------------------------------------------------------------------------------------------------

export const VOICE_KEY = "agency.voice";

interface VoiceChoice {
  id: string;
  name: string;
  personal: boolean;
}

export function loadVoice(): { id: string | null; rate: number } {
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    if (raw) return { id: null, rate: 1, ...(JSON.parse(raw) as object) };
  } catch {
    /* ignore */
  }
  return { id: null, rate: 1 };
}

function useVoices(): VoiceChoice[] | null {
  const [voices, setVoices] = useState<VoiceChoice[] | null>(null);
  useEffect(() => {
    const h = host();
    if (h) {
      h.native
        .call("speech.voices", {})
        .then((r) => setVoices(r.voices))
        .catch(() => setVoices([]));
      return;
    }
    const synth = window.speechSynthesis;
    if (!synth) {
      setVoices([]);
      return;
    }
    const read = () =>
      setVoices(
        synth
          .getVoices()
          .filter((v) => v.lang.startsWith("en"))
          .map((v) => ({ id: v.voiceURI, name: v.name, personal: false })),
      );
    read();
    synth.addEventListener("voiceschanged", read);
    return () => synth.removeEventListener("voiceschanged", read);
  }, []);
  return voices;
}

function say(text: string, voiceId: string | null, rate: number): void {
  const h = host();
  if (h) {
    void h.native.call("speech.say", { text, ...(voiceId ? { voiceId } : {}), rate });
    return;
  }
  const synth = window.speechSynthesis;
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = synth.getVoices().find((x) => x.voiceURI === voiceId);
  if (v) u.voice = v;
  u.rate = rate;
  synth.cancel();
  synth.speak(u);
}

export function VoiceSettings() {
  const voices = useVoices();
  const announce = useAnnounce();
  const [choice, setChoice] = useState(loadVoice);
  const [page, setPage] = useState(0);
  const save = (next: { id: string | null; rate: number }) => {
    setChoice(next);
    try {
      localStorage.setItem(VOICE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const PER = 4;
  const list = voices ?? [];
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const shown = list.slice(page * PER, page * PER + PER);
  return (
    <div className="flow" aria-label="Voice">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="speak" size={18} /> Settings
        </div>
        <h1>The voice that speaks for you</h1>
        <p className="muted">
          When you talk to someone through this voice, AGENCY tells them it is a synthetic voice.
          {host()
            ? ""
            : " In the browser these are the browser's voices; the Mac app also offers your Personal Voice."}
        </p>
      </div>
      {voices === null ? (
        <div className="flow-options flow-waiting">
          <p className="muted">Finding voices…</p>
        </div>
      ) : voices.length === 0 ? (
        <p className="panel">No voices are available here.</p>
      ) : (
        <div className="flow-options" data-count={shown.length + 2} role="group" aria-label="Voices">
          {shown.map((v) => (
            <button
              key={v.id}
              className="choice"
              aria-pressed={choice.id === v.id}
              onClick={() => {
                save({ ...choice, id: v.id });
                say(`Hello, this is my voice.`, v.id, choice.rate);
                announce(`${v.name} chosen.`);
              }}
              data-dwell
            >
              <span className="choice-pic" aria-hidden>
                <Icon name={choice.id === v.id ? "check" : "speak"} size={44} />
              </span>
              <span className="choice-label">{v.name}</span>
              <span className="choice-sub">
                {v.personal ? "Your Personal Voice" : "Look here to choose and hear it"}
              </span>
            </button>
          ))}
          <button
            className="choice"
            onClick={() => save({ ...choice, rate: Math.max(0.6, +(choice.rate - 0.1).toFixed(1)) })}
            data-dwell
          >
            <span className="choice-pic" aria-hidden>
              <Icon name="left" size={44} />
            </span>
            <span className="choice-label">Slower</span>
            <span className="choice-sub">Speed {choice.rate.toFixed(1)}</span>
          </button>
          <button
            className="choice"
            onClick={() => save({ ...choice, rate: Math.min(1.6, +(choice.rate + 0.1).toFixed(1)) })}
            data-dwell
          >
            <span className="choice-pic" aria-hidden>
              <Icon name="right" size={44} />
            </span>
            <span className="choice-label">Faster</span>
            <span className="choice-sub">Speed {choice.rate.toFixed(1)}</span>
          </button>
        </div>
      )}
      <div className="flow-bar" role="group" aria-label="Move around">
        <button className="btn btn-xl" onClick={() => navigate("/settings")} data-dwell>
          <Icon name="back" /> Back
        </button>
        <button className="btn btn-xl" onClick={() => navigate("/")} data-dwell>
          <Icon name="home" /> Home
        </button>
        <span className="spacer" />
        {pages > 1 && (
          <>
            <button className="btn btn-xl" onClick={() => setPage(page - 1)} disabled={page === 0} data-dwell>
              <Icon name="left" /> Previous
            </button>
            <span className="muted">
              {page + 1} of {pages}
            </span>
            <button
              className="btn btn-xl"
              onClick={() => setPage(page + 1)}
              disabled={page >= pages - 1}
              data-dwell
            >
              More <Icon name="right" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Memory -----------------------------------------------------------------------------------------------------

async function memoryCall(path: string, method: string): Promise<boolean> {
  const headers = new Headers();
  const token = accessToken();
  if (token) headers.set("X-Agency-Token", token);
  try {
    const r = await fetch(`${coordinatorUrl()}${path}`, { method, headers });
    return r.ok;
  } catch {
    return false;
  }
}

export function MemorySettings() {
  const announce = useAnnounce();
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [confirmAll, setConfirmAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    memory()
      .suggestions("home", 6)
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  const demo = memory().kind() === "demo";
  const shown = (items ?? []).filter((s) => !hidden.includes(s.nodeId)).slice(0, 4);

  const forget = async (s: Suggestion) => {
    const ok = demo || (await memoryCall(`/api/memory/nodes/${encodeURIComponent(s.nodeId)}`, "DELETE"));
    const text = ok ? `Forgot ${s.label}.` : `Couldn't forget ${s.label}. Try again.`;
    if (ok) setHidden((h) => [...h, s.nodeId]);
    setNotice(text);
    announce(text);
  };

  return (
    <div className="flow" aria-label="What AGENCY remembers">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="sparkle" size={18} /> Settings
          {demo && (
            <span className="badge" data-tone="sim">
              Demo examples
            </span>
          )}
        </div>
        <h1>What AGENCY remembers</h1>
        <p className="muted" role="status">
          {notice ??
            "It remembers what you choose, only on this computer, to offer your usuals first. Look at one to forget it."}
        </p>
      </div>
      {items === null ? (
        <div className="flow-options flow-waiting">
          <p className="muted">Loading…</p>
        </div>
      ) : (
        <div className="flow-options" data-count={shown.length + 1} role="group" aria-label="Remembered">
          {shown.map((s) => (
            <button key={s.nodeId} className="choice" onClick={() => void forget(s)} data-dwell>
              <span className="choice-label">{s.label}</span>
              <span className="choice-sub">{s.reason}</span>
              <span className="choice-sub">
                <Icon name="x" size={18} /> Forget this
              </span>
            </button>
          ))}
          <button className="choice choice-danger" onClick={() => setConfirmAll(true)} data-dwell>
            <span className="choice-pic" aria-hidden>
              <Icon name="x" size={44} />
            </span>
            <span className="choice-label">Erase everything</span>
            <span className="choice-sub">Start again from nothing</span>
          </button>
        </div>
      )}
      {confirmAll && (
        <ConfirmSheet
          title="Erase everything AGENCY remembers?"
          confirmLabel="Yes, erase everything"
          tone="danger"
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            void (async () => {
              const ok = demo || (await memoryCall("/api/memory/forget-all", "POST"));
              if (ok) setHidden((items ?? []).map((s) => s.nodeId));
              const text = ok ? "Everything was erased." : "Couldn't erase. Try again.";
              setNotice(text);
              announce(text);
            })();
          }}
        >
          <p>
            Your usuals and everything AGENCY learned about your choices will be gone. This can&apos;t be
            undone.
          </p>
        </ConfirmSheet>
      )}
      <Bar backTo="/settings" />
    </div>
  );
}

// ---- Talk -------------------------------------------------------------------------------------------------------

export function TalkPlaceholder() {
  const items: Choice[] = [
    {
      id: "messages",
      label: "Send a message",
      sub: "Quick messages",
      icon: "message",
      path: "/flow/messages",
    },
    {
      id: "call",
      label: "Call someone",
      sub: "With your synthetic voice",
      icon: "phone",
      path: "/flow/call",
    },
  ];
  return (
    <div className="flow" aria-label="Talk">
      <div className="flow-head">
        <div className="eyebrow">
          <Icon name="speak" size={18} /> Talk
        </div>
        <h1>Talk isn&apos;t in this build yet</h1>
        <p className="muted">Saying things out loud with your voice is coming. For now you can:</p>
      </div>
      <ChoiceGrid items={items} label="Instead" />
      <Bar backTo="/" />
    </div>
  );
}
