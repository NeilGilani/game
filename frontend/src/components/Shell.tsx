import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Approval } from "../api/types";
import { useAnnounce } from "../state/announcer";
import { coordinatorLabel, useConnection } from "../state/connection";
import { MODE_LABELS, useInput } from "../state/input";
import { navigate, useRoute, type Route } from "../state/router";
import { usePoll } from "../state/usePoll";
import { useLifeline } from "../lifeline/LifelineProvider";
import { useAgent } from "../state/agent";
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
  const route = useRoute();
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

  const agent = useAgent();
  const togglePause = async () => {
    // Stop reaches the agent and all synthetic input at once, before anything else (even if the coordinator is down).
    if (!paused) agent.stopAll();
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
      announce(
        paused
          ? "Couldn't reach the coordinator to resume automation."
          : "Tasks on this computer were stopped. Couldn't reach the coordinator to stop its errands too.",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const keyboard = () => {
    // Typing happens with the Mac app's eye keyboard (overlay) or a helper's keyboard; this puts the cursor where
    // the text goes.
    const field = document.querySelector<HTMLElement>("#main textarea, #main input:not([type=checkbox])");
    if (field) {
      field.focus();
      announce("Ready to type. Use the eye keyboard, or a helper's keyboard.");
    } else announce("There's nothing to type into on this screen.");
  };

  return (
    <>
      <header className="topbar dock" aria-label="Always here">
        <HelpButton />
        <button
          className="btn dock-btn"
          onClick={() => navigate("/")}
          aria-label="Home"
          data-dock="home"
          aria-current={route.path === "/" ? "page" : undefined}
          data-dwell
        >
          <Icon name="home" size={30} />
          <span>Home</span>
        </button>
        <button
          className="btn dock-btn"
          onClick={() => navigate("/talk")}
          data-dock="talk"
          aria-current={route.segments[0] === "talk" ? "page" : undefined}
          data-dwell
        >
          <Icon name="speak" size={30} />
          <span>Talk</span>
        </button>
        <button className="btn dock-btn" onClick={keyboard} data-dock="keyboard" data-dwell>
          <Icon name="keyboard" size={30} />
          <span>Keyboard</span>
        </button>
        {input.usesCamera && input.status === "running" && (
          <button
            className="btn dock-btn"
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
            <Icon name={input.eyeControlPaused ? "play" : "pause"} size={30} />
            <span>{input.eyeControlPaused ? "Resume eye control" : "Pause eye control"}</span>
          </button>
        )}
        <button
          className={`btn dock-btn pause-agent ${paused ? "" : "btn-danger"}`}
          data-paused={paused}
          data-dock="agent"
          onClick={togglePause}
          disabled={busy || (!online && paused)}
          data-dwell
          data-dwell-always
          aria-pressed={paused}
        >
          <Icon name={paused ? "play" : "stop"} size={30} />
          <span>{paused ? "Resume agent" : "Stop agent"}</span>
        </button>
      </header>
      <div className="menubar">
        <span className="menubar-brand">
          <BrandMark />
          AGENCY
        </span>
        <DesktopMenus />
        <Clock />
        <div className="status-strip" aria-label="System status">
          <a className="chip" data-tone={online ? "ok" : "danger"} href="#/status" title={coord.long}>
            <Icon name={!online ? "offline" : health?.node.is_raspberry_pi ? "chip" : "laptop"} size={18} />
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
            <Icon name={reasoning?.mode === "deterministic" ? "shield" : "sparkle"} size={18} />
            <strong>{reasoningText}</strong>
          </a>
          <a className="chip" data-tone={chip.tone} href="#/camera" title={MODE_LABELS[input.mode].long}>
            <Icon name={input.usesCamera ? "eye" : input.mode === "scan_key" ? "key" : "pointer"} size={18} />
            <strong>{chip.text}</strong>
          </a>
        </div>
      </div>
    </>
  );
}

/** Helper menus complement the large eye-selectable choices on Home and in the Dock. */
function DesktopMenus() {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".desktop-menu")) setOpen(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        document.querySelector<HTMLButtonElement>(".desktop-menu [aria-expanded=true]")?.focus();
        setOpen(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  const menus = [
    {
      label: "View",
      items: [
        { label: "Home", icon: "home", path: "/" },
        { label: "Talk", icon: "speak", path: "/talk" },
        { label: "Settings", icon: "gear", path: "/settings" },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Camera setup", icon: "camera", path: "/camera" },
        { label: "For a helper", icon: "question", path: "/settings/helper" },
        { label: "System status", icon: "info", path: "/status" },
      ],
    },
  ];
  return (
    <nav className="desktop-menu" aria-label="Application menu">
      {menus.map((menu) => (
        <div className="desktop-menu-item" key={menu.label}>
          <button
            aria-expanded={open === menu.label}
            aria-controls={`desktop-menu-${menu.label}`}
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
          >
            {menu.label}
          </button>
          {open === menu.label && (
            <div className="desktop-menu-popover" id={`desktop-menu-${menu.label}`}>
              {menu.items.map((item) => (
                <a key={item.path} href={`#${item.path}`} onClick={() => setOpen(null)}>
                  <Icon name={item.icon} /> {item.label}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

/** The time, to the minute. It changes once a minute and never moves. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="menubar-time">
      {now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}{" "}
      {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
    </span>
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
      className="btn dock-btn help-btn"
      onClick={() => void ll.requestHelp("help_button")}
      data-dwell
      data-dwell-always
      aria-label={open ? "Help: an alert is already open" : "Help: call for help"}
    >
      <Icon name="bell" size={30} />
      <span>Help</span>
    </button>
  );
}

const NAV = [
  { path: "/", label: "Home", icon: "home", match: (r: Route) => r.path === "/" },
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
        <a className="btn btn-quiet" href="#/settings/connection" data-dwell>
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
        <a className="btn" href="#/settings/connection" data-dwell>
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
