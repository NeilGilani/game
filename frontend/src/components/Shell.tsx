import { useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Approval } from "../api/types";
import { useAnnounce } from "../state/announcer";
import { coordinatorLabel, useConnection } from "../state/connection";
import { MODE_LABELS, useInput } from "../state/input";
import { navigate, type Route } from "../state/router";
import { usePoll } from "../state/usePoll";
import { useLifeline } from "../lifeline/LifelineProvider";
import { BrandMark, Icon } from "./Icon";

function useInputChip(): { text: string; tone: string } {
  const input = useInput();
  const label = MODE_LABELS[input.mode].short;
  if (!input.usesCamera) return { text: label, tone: "neutral" };
  if (input.status === "error") return { text: `${label} · camera problem`, tone: "danger" };
  if (input.status === "off") return { text: `${label} · camera off`, tone: "warn" };
  if (input.status === "starting" || input.status === "loading-model")
    return { text: `${label} · starting`, tone: "neutral" };
  if (input.status === "paused") return { text: `${label} · paused`, tone: "warn" };
  if (input.calibrationNeeded) return { text: `${label} · needs calibration`, tone: "warn" };
  if (input.eyeControlPaused) return { text: `${label} · selection paused`, tone: "warn" };
  if (input.tracking === "lost") return { text: `${label} · tracking lost`, tone: "danger" };
  if (input.tracking === "weak") return { text: `${label} · tracking weak`, tone: "warn" };
  return { text: `${label} · tracking`, tone: "ok" };
}

export function TopBar() {
  const { health, online, refresh } = useConnection();
  const input = useInput();
  const announce = useAnnounce();
  const chip = useInputChip();
  const [busy, setBusy] = useState(false);
  const coord = coordinatorLabel(health, online);
  const paused = !!health?.automation_paused;
  const reasoning = health?.reasoning;
  const reasoningText = !reasoning
    ? "Reasoning: …"
    : reasoning.mode === "deterministic"
      ? "Demo mode: built-in plans"
      : reasoning.state === "error"
        ? `${reasoning.label ?? "Cloud model"} unavailable: built-in plans`
        : `${reasoning.label ?? "Cloud"} · ${reasoning.model ?? "cloud"}`;
  const reasoningTone = !reasoning
    ? "neutral"
    : reasoning.mode === "deterministic"
      ? "sim"
      : reasoning.state === "error"
        ? "warn"
        : "ok";

  const togglePause = async () => {
    setBusy(true);
    try {
      if (paused) await api.resumeAll();
      else await api.pauseAll();
      announce(
        paused ? "Automation resumed." : "All automation stopped. Nothing will run until you resume.",
        true,
      );
      await refresh();
    } catch {
      announce("Couldn't reach the coordinator to change automation.", true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="topbar">
      <HelpButton />
      <button className="brand" onClick={() => navigate("/")} aria-label="AGENCY home" data-dwell>
        <BrandMark />
        AGENCY
      </button>
      <div className="status-strip" aria-label="System status">
        <a className="chip" data-tone={online ? "ok" : "danger"} href="#/status" title={coord.long}>
          <Icon name={!online ? "offline" : health?.node.is_raspberry_pi ? "chip" : "laptop"} size={20} />
          <span>
            <span className="chip-label">Coordinator: </span>
            <strong>{coord.short}</strong>
          </span>
        </a>
        <a
          className="chip chip-optional"
          data-tone={reasoningTone}
          href="#/status"
          title={reasoning?.description}
        >
          <Icon name={reasoning?.mode === "deterministic" ? "shield" : "sparkle"} size={20} />
          <strong>{reasoningText}</strong>
        </a>
        <a className="chip" data-tone={chip.tone} href="#/camera" title={MODE_LABELS[input.mode].long}>
          <Icon name={input.usesCamera ? "eye" : input.mode === "scan_key" ? "key" : "pointer"} size={20} />
          <strong>{chip.text}</strong>
        </a>
      </div>
      {input.usesCamera && input.status === "running" && (
        <button
          className="btn btn-quiet"
          onClick={() => {
            input.setEyeControlPaused(!input.eyeControlPaused);
            announce(
              input.eyeControlPaused
                ? "Eye control resumed."
                : "Eye control paused. Look at Resume eye control to turn it back on.",
            );
          }}
          data-dwell
          data-dwell-always={input.eyeControlPaused ? "" : undefined}
          aria-pressed={input.eyeControlPaused}
        >
          <Icon name={input.eyeControlPaused ? "play" : "pause"} />
          {input.eyeControlPaused ? "Resume eye control" : "Pause eye control"}
        </button>
      )}
      <button
        className={`btn pause-agent ${paused ? "" : "btn-danger"}`}
        data-paused={paused}
        onClick={togglePause}
        disabled={busy || !online}
        data-dwell
        aria-pressed={paused}
      >
        <Icon name={paused ? "play" : "stop"} />
        {paused ? "Resume agent" : "Stop agent"}
      </button>
    </header>
  );
}

/**
 * Always first in the top bar, so it's the first choice when scanning. It stays selectable
 * while eye control is paused (with a longer dwell). Pressing it starts the cancel countdown.
 */
function HelpButton() {
  const ll = useLifeline();
  const open = !!ll.open || !!ll.queued;
  return (
    <button
      className="btn help-btn"
      onClick={() => void ll.requestHelp("help_button")}
      data-dwell
      data-dwell-always
      aria-label={open ? "Help: an alert is already open" : "Help: call for help"}
    >
      <Icon name="bell" size={28} />
      Help
    </button>
  );
}

const NAV = [
  { path: "/", label: "Home", icon: "home", match: (r: Route) => r.path === "/" },
  { path: "/talk", label: "Talk", icon: "speaker", match: (r: Route) => r.segments[0] === "talk" },
  {
    path: "/lifeline",
    label: "Lifeline",
    icon: "lifeline",
    match: (r: Route) => r.segments[0] === "lifeline",
  },
  { path: "/new", label: "New task", icon: "plus", match: (r: Route) => r.segments[0] === "new" },
  {
    path: "/cases",
    label: "Cases",
    icon: "list",
    match: (r: Route) =>
      r.segments[0] === "cases" || (r.segments[0] === "case" && r.segments[2] !== "approve"),
  },
  {
    path: "/approvals",
    label: "Approvals",
    icon: "hand",
    match: (r: Route) => r.segments[0] === "approvals" || r.segments[2] === "approve",
  },
  {
    path: "/settings",
    label: "Settings",
    icon: "gear",
    match: (r: Route) => ["settings", "preferences", "camera", "calibrate"].includes(r.segments[0] ?? ""),
  },
  { path: "/status", label: "Status", icon: "info", match: (r: Route) => r.segments[0] === "status" },
];

export function Nav({ route }: { route: Route }) {
  const approvals = usePoll<Approval[]>(() => api.approvals(), 3000, "nav-approvals");
  const count = approvals.data?.length ?? 0;
  const ll = useLifeline();
  const watching = !!ll.status?.monitor.armed;
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map((item) => (
        <button
          key={item.path}
          className="nav-item"
          aria-current={item.match(route) ? "page" : undefined}
          onClick={() => navigate(item.path)}
          data-dwell
        >
          <Icon name={item.icon} />
          {item.label}
          {item.path === "/approvals" && count > 0 && (
            <span className="count" aria-label={`${count} waiting`}>
              {count}
            </span>
          )}
          {item.path === "/lifeline" && watching && (
            <span className="count count-ok" aria-label="Watch over me is on">
              On
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

export function ConnectionBanner() {
  const { online, health, refresh, address, authProblem, checking } = useConnection();
  if (checking) return null;
  if (!online) {
    return (
      <div className="banner banner-danger" role="alert">
        <Icon name="offline" />
        <span>
          Can't reach the coordinator at {address}. Your cases are saved on the coordinator; nothing runs
          until it's back.
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => void refresh()} data-dwell>
          <Icon name="refresh" /> Try again
        </button>
        <a className="btn btn-quiet" href="#/settings" data-dwell>
          Change address
        </a>
      </div>
    );
  }
  if (authProblem) {
    return (
      <div className="banner banner-warn" role="alert">
        <Icon name="key" />
        <span>This coordinator needs an access token. Add it in Settings.</span>
        <span className="spacer" />
        <a className="btn" href="#/settings" data-dwell>
          Open settings
        </a>
      </div>
    );
  }
  if (health?.automation_paused) {
    return (
      <div className="banner banner-warn" role="status">
        <Icon name="pause" />
        <span>Automation is stopped. AGENCY won't take any step until you press Resume agent.</span>
      </div>
    );
  }
  return null;
}

export function Page({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="page" aria-label={label}>
      {children}
    </div>
  );
}
