/** Draws an OverlayView. All positions come from the controller (global points) minus the display origin. */

import { useEffect, useRef, type CSSProperties } from "react";
import type { ScreenRect } from "../contracts";
import type { OverlayButton, OverlayView } from "../core/controller";
import { MenuIcon, NavIcon, NoticeIcon, RailIcon, hasNavIcon } from "./icons";

interface Props {
  view: OverlayView;
  onActivate(id: string): void;
}

export function Overlay({ view, onActivate }: Props) {
  const o = view.display;
  const pos = (r: ScreenRect) => ({ left: r.x - o.x, top: r.y - o.y, width: r.width, height: r.height });
  const railTop = view.buttons.find((b) => b.id === "overlay:help")?.rect;
  const chipsX = view.railSide === "right" ? o.width - 16 - 96 - 24 - 420 : 16 + 96 + 24;
  const status: string[] = [];
  if (view.paused) status.push("Eye control paused");
  if (view.tracking === "lost") status.push("Can't see your eyes");
  else if (view.tracking === "weak") status.push("Eyes hard to see");
  if (view.pointer === "right-click") status.push("Right-click: look at a control");
  if (view.pointer === "double-click") status.push("Double-click: look at a control");
  if (view.pointer === "drag")
    status.push(view.dragging ? "Drag: look where to drop" : "Drag: look at what to pick up");
  if (view.helpProgress > 0) status.push(`Help signal: ${view.helpProgress} of 3`);

  return (
    <div className={`ov${view.paused ? " paused" : ""}`} data-testid="overlay" data-paused={view.paused}>
      {view.panel && (
        <section
          className="ov-panel"
          data-kind={view.panel.kind}
          style={pos(view.panel.rect)}
          aria-label={view.panel.title}
          data-testid={`panel-${view.panel.kind}`}
        >
          <h2>
            {view.panel.title}
            {view.panel.pages > 1 && (
              <span className="ov-page">
                {" "}
                · page {view.panel.page + 1} of {view.panel.pages}
              </span>
            )}
          </h2>
        </section>
      )}
      {view.keyboard && (
        <section
          className="ov-keyboard"
          style={pos(view.keyboard.rect)}
          aria-label="Keyboard"
          data-testid="keyboard"
        >
          {view.keyboard.secure && (
            <p className="ov-secure" role="status">
              <NoticeIcon tone="warn" />
              This is a password box. AGENCY never types passwords. Ask a helper, or use a passkey.
            </p>
          )}
        </section>
      )}
      {view.map && (
        <div className="ov-map" style={pos(view.map.rect)} aria-hidden="true" data-testid="map">
          {view.map.boxes.map((b) => (
            <div
              key={b.n}
              className="box"
              style={{
                left: b.rect.x - view.map!.rect.x,
                top: b.rect.y - view.map!.rect.y,
                width: b.rect.width,
                height: b.rect.height,
              }}
            >
              <span>{b.n}</span>
            </div>
          ))}
        </div>
      )}
      {view.badges.map((b) => (
        <span
          key={b.n}
          className="ov-badge"
          style={{ left: b.rect.x - o.x, top: b.rect.y - o.y }}
          aria-hidden="true"
        >
          {b.n}
        </span>
      ))}
      {view.buttons.map((b) => (
        <OverlayBtn
          key={b.id}
          b={b}
          style={pos(b.rect)}
          paused={view.paused}
          scan={view.scanHighlight === b.id}
          launch={view.launched?.id === b.id ? view.launched.n : 0}
          onActivate={onActivate}
        />
      ))}
      {view.focus && (
        <DwellRing rect={pos(view.focus.rect)} progress={view.focus.progress} kind={view.focus.kind} />
      )}
      {view.notice && (
        <div
          className="ov-notice"
          data-tone={view.notice.tone}
          role="status"
          aria-live="polite"
          style={{ left: chipsX, top: Math.max(16, (railTop?.y ?? 130) - o.y) }}
          data-testid="notice"
        >
          <NoticeIcon tone={view.notice.tone} />
          <span>{view.notice.text}</span>
        </div>
      )}
      {status.length > 0 && (
        <div className="ov-status" style={{ left: chipsX, top: 16 }} data-testid="status">
          {status.join(" · ")}
        </div>
      )}
      {view.cursor && (
        <div
          className="ov-cursor"
          data-weak={view.cursor.confidence < 0.5}
          style={{
            transform: `translate(${view.cursor.x - o.x}px, ${view.cursor.y - o.y}px)`,
            left: 0,
            top: 0,
          }}
          aria-hidden="true"
          data-testid="cursor"
        />
      )}
    </div>
  );
}

function OverlayBtn({
  b,
  style,
  paused,
  scan,
  launch,
  onActivate,
}: {
  b: OverlayButton;
  style: CSSProperties;
  paused: boolean;
  scan: boolean;
  /** Increments each time this control is chosen: plays the "launch" pulse (DESIGN.md: Motion). */
  launch: number;
  onActivate(id: string): void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!launch || !el || reducedMotion()) return;
    el.dataset.launched = "";
    const end = () => delete el.dataset.launched;
    el.addEventListener("animationend", end, { once: true });
    return () => el.removeEventListener("animationend", end);
  }, [launch]);
  const name = b.kind === "key" ? (b.detail ?? b.label) : b.detail ? `${b.label}, ${b.detail}` : b.label;
  return (
    <button
      ref={ref}
      type="button"
      className="ov-btn"
      style={style}
      data-id={b.id}
      data-testid={b.kind === "rail" ? b.id.replace(":", "-") : undefined}
      data-kind={b.kind}
      data-tone={b.tone ?? "plain"}
      data-protected={b.protected === true}
      data-active={b.active === true}
      data-scan={scan}
      aria-label={b.n !== undefined ? `${b.n}: ${name}` : name}
      aria-pressed={b.active === true ? true : undefined}
      onClick={() => onActivate(b.id)}
    >
      {b.n !== undefined && <span className="ov-n">{b.n}</span>}
      {b.kind === "rail" && <RailIcon id={b.id} paused={paused} />}
      {b.kind === "item" && b.n === undefined && !b.iconPng && b.id.startsWith("menu:") && (
        <span className="ov-plate">
          <MenuIcon id={b.id} />
        </span>
      )}
      {b.iconPng && <img src={`data:image/png;base64,${b.iconPng}`} alt="" />}
      {hasNavIcon(b.id) && <NavIcon id={b.id} />}
      {b.kind === "item" ? (
        <span className="ov-text">
          <span>{b.label}</span>
          {b.detail && <span className="ov-detail">{b.detail}</span>}
        </span>
      ) : (
        <>
          <span>{b.label}</span>
          {b.detail && b.kind !== "key" && <span className="ov-detail">{b.detail}</span>}
        </>
      )}
    </button>
  );
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** DESIGN.md dwell feedback: a 4 px outline and an activity ring that fills as the dwell completes. */
function DwellRing({ rect: r, progress, kind }: { rect: Box; progress: number; kind: string }) {
  const pad = 6;
  const ring = 38;
  // On the overlay's own buttons the ring sits inside the top-right corner, like the shell. On app controls it
  // sits just outside that corner so it never covers the control the person is looking at.
  const inside = kind === "overlay";
  const ringLeft = inside ? r.left + r.width - ring - 8 : r.left + r.width + pad + 4;
  const ringTop = inside ? r.top + 8 : r.top - pad - ring / 2;
  return (
    <>
      <div
        className="ov-focus"
        data-kind={kind}
        style={{ left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }}
        aria-hidden="true"
        data-testid="dwell-ring"
        data-progress={progress.toFixed(2)}
      />
      <div
        className="ov-ring"
        style={{ left: ringLeft, top: ringTop, ["--dwell" as string]: progress } as CSSProperties}
        aria-hidden="true"
      />
    </>
  );
}

function reducedMotion(): boolean {
  return (
    document.documentElement.hasAttribute("data-reduced-motion") ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
