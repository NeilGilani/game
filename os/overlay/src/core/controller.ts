/**
 * The overlay's brain: gaze in, targets in, actions out. Pure apart from the host calls, driven by the
 * gaze engine's clock, so every rule here is tested with fake gaze and fake targets (tests/).
 *
 * Safety rules, each covered by tests/controller.test.ts:
 * - Help and Stop act first and synchronously; nothing else runs before them, nothing can block them.
 * - While eye control is paused only the protected rail (Help, Stop, Home, Keyboard, Resume) responds.
 * - When several app controls sit inside the gaze error circle the overlay asks "which one?" instead of
 *   guessing; it never presses something the person didn't clearly choose.
 * - Dwell ends in an accessibility press (ax.press); a synthetic click is only the fallback, and the
 *   person is told when that happened.
 * - The keyboard never types into, shows, learns from or logs a password field.
 * - Pointer modes (right-click, double-click, drag) are one-shot: they return to a plain press after use.
 * - Panels open away from what the person was looking at; the overlay never covers it.
 */

import { DwellEngine, type DwellConfig } from "../../../../frontend/src/input/dwell";
import { ScanEngine } from "../../../../frontend/src/input/scan";
import type { AppInfo, GazeEvent, ScreenRect, Target, TargetSnapshot, TrackingState } from "../contracts";
import type { OverlayHost } from "../host/host";
import { NgramModel, currentWord } from "../keyboard/ngram";
import {
  layoutKeyboard,
  placeKeyboard,
  type KeyAction,
  type KeyboardPage,
  PREDICTION_SLOTS,
} from "../keyboard/layout";
import { center, contains, intersection, pickTarget, readingOrder, type Point } from "./geometry";
import {
  GAP,
  boundsOf,
  gridSize,
  layoutGrid,
  layoutRail,
  paginate,
  placePanel,
  usableArea,
  type GridSpec,
  type RailSide,
} from "./layout";
import { decidePrecision, errorRadiusFor, type PrecisionConfig } from "./precision";

export type PointerMode = "press" | "right-click" | "double-click" | "drag";
export type PanelKind = "menu" | "picker" | "numbers" | "apps" | "scroll";
export type ButtonKind = "rail" | "item" | "nav" | "key" | "zone";
export type Tone = "help" | "stop" | "accent" | "plain" | "quiet";

export interface OverlayButton {
  id: string;
  rect: ScreenRect;
  label: string;
  /** Second line, e.g. the control's role or the app's state. */
  detail?: string;
  kind: ButtonKind;
  tone?: Tone;
  protected?: boolean;
  dwellScale?: number;
  /** A number shown with the item (numbers mode, magnifier map). */
  n?: number;
  /** Base64 PNG for app icons. */
  iconPng?: string;
  active?: boolean;
}

export interface PanelView {
  kind: PanelKind;
  rect: ScreenRect;
  title: string;
  page: number;
  pages: number;
}

export interface Notice {
  text: string;
  tone: "info" | "warn" | "ok";
}

export interface OverlayView {
  display: ScreenRect;
  paused: boolean;
  railSide: RailSide;
  pointer: PointerMode;
  dragging: boolean;
  cursor: { x: number; y: number; confidence: number } | null;
  tracking: TrackingState;
  focus: { id: string; rect: ScreenRect; progress: number; kind: "overlay" | "app" | "cluster" } | null;
  buttons: OverlayButton[];
  panel: PanelView | null;
  keyboard: { rect: ScreenRect; secure: boolean; shift: boolean; page: KeyboardPage } | null;
  /** Numbers mode: a badge on every listed control. */
  badges: { n: number; rect: ScreenRect }[];
  /** "Which one?" with many candidates: a zoomed map of the area with numbered boxes. */
  map: { rect: ScreenRect; region: ScreenRect; boxes: { n: number; rect: ScreenRect }[] } | null;
  notice: Notice | null;
  scanHighlight: string | null;
  helpProgress: number;
}

export interface ControllerOptions {
  display: ScreenRect;
  railSide?: RailSide;
  dwell?: Partial<DwellConfig>;
  precision?: Partial<PrecisionConfig>;
  /** The shell runs its own dwell; by default the overlay leaves shell targets to it. */
  dwellShellTargets?: boolean;
  /** Time between pages while the gaze stays on a scroll zone. */
  scrollRepeatMs?: number;
}

const RAIL: { id: string; label: string; tone: Tone; protected: boolean; dwellScale?: number }[] = [
  { id: "overlay:help", label: "Help", tone: "help", protected: true },
  { id: "overlay:stop", label: "Stop", tone: "stop", protected: true, dwellScale: 0.75 },
  { id: "overlay:home", label: "Home", tone: "plain", protected: true },
  { id: "overlay:keyboard", label: "Keyboard", tone: "plain", protected: true },
  { id: "overlay:more", label: "More", tone: "plain", protected: false },
  { id: "overlay:pause", label: "Pause eyes", tone: "quiet", protected: true },
];

const MENU: { id: string; label: string; detail: string }[] = [
  { id: "menu:numbers", label: "Numbers", detail: "List every control" },
  { id: "menu:scroll", label: "Scroll", detail: "Page up and down" },
  { id: "menu:apps", label: "Apps", detail: "Switch or open" },
  { id: "menu:right-click", label: "Right-click", detail: "Next look only" },
  { id: "menu:double-click", label: "Double-click", detail: "Next look only" },
  { id: "menu:drag", label: "Drag", detail: "Pick up, then drop" },
  { id: "menu:side", label: "Move buttons", detail: "To the other side" },
];

const ITEM_GRID: GridSpec = { columns: 2, rows: 3, cell: { width: 260, height: 112 } };
const MENU_GRID: GridSpec = { columns: 4, rows: 2, cell: { width: 220, height: 120 } };
const APP_GRID: GridSpec = { columns: 4, rows: 2, cell: { width: 200, height: 160 } };
const NAV_H = 96;
const PANEL_PAD = 24;
const TITLE_H = 48;

interface Cluster {
  id: string;
  candidates: Target[];
  anchor: ScreenRect;
  magnify: boolean;
}

export class OverlayController {
  private readonly host: OverlayHost;
  private display: ScreenRect;
  private railSide: RailSide;
  private readonly dwell: DwellEngine;
  private readonly scan = new ScanEngine();
  private precision: Partial<PrecisionConfig>;
  private readonly dwellShell: boolean;
  private readonly scrollRepeatMs: number;

  private paused = false;
  private pointer: PointerMode = "press";
  private dragFrom: Point | null = null;
  private panel: PanelKind | null = null;
  private page = 0;
  private picker: Cluster | null = null;
  private attention: ScreenRect | null = null;
  private apps: AppInfo[] = [];
  private snapshot: TargetSnapshot = { t: 0, owner: null, targets: [], truncated: false };

  private keyboardOpen = false;
  private kbPage: KeyboardPage = "letters";
  private shift = false;
  private composition = "";
  private field: Target | null = null;
  private phrases: string[] = [];
  private readonly model = new NgramModel();

  private gaze: { t: number; x: number; y: number; confidence: number } | null = null;
  private tracking: TrackingState = "ok";
  private hitId: string | null = null;
  private cluster: Cluster | null = null;
  private notice: Notice | null = null;
  private scanHighlight: string | null = null;
  private helpProgress = 0;
  private scrolling: { zone: string; nextAt: number } | null = null;
  private lastContentPoint: Point | null = null;

  private cachedButtons: OverlayButton[] | null = null;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(host: OverlayHost, options: ControllerOptions) {
    this.host = host;
    this.display = options.display;
    this.railSide = options.railSide ?? "right";
    this.dwell = new DwellEngine(options.dwell);
    this.precision = options.precision ?? {};
    this.dwellShell = options.dwellShellTargets ?? false;
    this.scrollRepeatMs = options.scrollRepeatMs ?? 1500;
  }

  // ---------------------------------------------------------------- inputs

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion(): number {
    return this.version;
  }

  setDisplay(display: ScreenRect): void {
    this.display = display;
    this.changed(true);
  }

  setTargets(snapshot: TargetSnapshot): void {
    this.snapshot = snapshot;
    // The field the keyboard types into keeps its identity across refreshes; drop it if it vanished.
    if (this.field && snapshot.owner !== null) {
      const still = snapshot.targets.find((t) => t.id === this.field?.id);
      if (still) this.field = still;
    }
    if (this.panel === "numbers") this.changed(true);
    else this.changed(false);
  }

  handleGaze(event: GazeEvent): void {
    switch (event.type) {
      case "sample":
        this.onSample(event.sample.t, event.sample.x, event.sample.y, event.sample.confidence);
        return;
      case "tracking":
        this.tracking = event.state;
        if (event.state === "lost") this.scrolling = null;
        this.changed(false);
        return;
      case "calibration":
        this.precision = { ...this.precision, errorPt: errorRadiusFor(event.quality.meanErrorPt) };
        return;
      case "switch":
        this.onSwitch(event.t);
        return;
      case "help-progress":
        this.helpProgress = event.counted;
        this.changed(false);
        return;
      case "help-signal":
        // The main process forwards the help signal to Lifeline (contracts/gaze.ts); the overlay only
        // clears its meter so it never shows a stale count.
        this.helpProgress = 0;
        this.changed(false);
        return;
      case "blink":
        return;
    }
  }

  /** Time passes: switch scanning and scroll repeats. Call from the gaze clock or a timer. */
  tick(now: number): void {
    for (const e of this.scan.tick(now)) {
      if (e.type === "highlight") {
        this.scanHighlight = e.id;
        this.changed(false);
      }
    }
    if (this.scrolling && now >= this.scrolling.nextAt) {
      const g = this.gaze;
      const zone = this.buttons().find((b) => b.id === this.scrolling?.zone);
      if (g && zone && g.confidence >= 0.5 && contains(zone.rect, g)) {
        this.scrollPage(zone.id);
        this.scrolling.nextAt = now + this.scrollRepeatMs;
      } else {
        this.scrolling = null;
      }
    }
  }

  // ---------------------------------------------------------------- view

  view(): OverlayView {
    const buttons = this.buttons();
    const snap = this.dwell.snapshot();
    let focus: OverlayView["focus"] = null;
    if (snap.targetId) {
      const b = buttons.find((x) => x.id === snap.targetId);
      const ext = this.snapshot.targets.find((t) => t.id === snap.targetId);
      const c = this.cluster?.id === snap.targetId ? this.cluster : null;
      const r = b?.rect ?? ext?.rect ?? c?.anchor;
      if (r) {
        focus = {
          id: snap.targetId,
          rect: r,
          progress: snap.progress,
          kind: b ? "overlay" : c ? "cluster" : "app",
        };
      }
    }
    const kb = this.keyboardOpen && !this.paused ? this.keyboardFrame() : null;
    return {
      display: this.display,
      paused: this.paused,
      railSide: this.railSide,
      pointer: this.pointer,
      dragging: this.dragFrom !== null,
      cursor: this.gaze ? { x: this.gaze.x, y: this.gaze.y, confidence: this.gaze.confidence } : null,
      tracking: this.tracking,
      focus,
      buttons,
      panel: this.panelView(),
      keyboard: kb
        ? { rect: kb.rect, secure: this.field?.secure === true, shift: this.shift, page: this.kbPage }
        : null,
      badges: this.panel === "numbers" ? this.numbered().map((e) => ({ n: e.n, rect: e.t.rect })) : [],
      map: this.mapView(),
      notice: this.notice,
      scanHighlight: this.scanHighlight,
      helpProgress: this.helpProgress,
    };
  }

  /** Every button the overlay draws right now, in scan order (rail first). */
  buttons(): OverlayButton[] {
    if (this.cachedButtons) return this.cachedButtons;
    const out: OverlayButton[] = [...this.railButtons()];
    if (!this.paused) {
      out.push(...this.panelButtons());
      out.push(...this.keyboardButtons());
    }
    this.cachedButtons = out;
    return out;
  }

  // ---------------------------------------------------------------- activation

  /** Select something by id: from dwell, a switch, or a helper's mouse click on the overlay. */
  activate(id: string): void {
    // Lifeline first, before anything else can throw or wait.
    if (id === "overlay:help") {
      this.host.lifeline({ type: "lifeline.help", source: "help_button" });
      this.host.lifeline({ type: "lifeline.surface" });
      this.say("Sending a help alert. The help screen is opening.", "warn");
      return;
    }
    if (id === "overlay:stop") {
      this.host.stopAll();
      this.scrolling = null;
      this.dragFrom = null;
      this.pointer = "press";
      this.closePanel();
      this.say("Stopped. Nothing else will happen until you choose.", "ok");
      return;
    }
    const button = this.buttons().find((b) => b.id === id);
    if (this.paused && !(button?.protected ?? false)) return;

    if (id === "overlay:pause") return this.setPaused(!this.paused);
    // Home and Keyboard while paused mean "I want to do something": they switch eye control back on.
    if ((id === "overlay:home" || id === "overlay:keyboard") && this.paused) this.setPaused(false);
    if (id === "overlay:home") {
      this.closePanel();
      this.host.home();
      return;
    }
    if (id === "overlay:keyboard") return this.toggleKeyboard();
    if (id === "overlay:more") return this.openPanel(this.panel === "menu" ? null : "menu");
    if (id === "panel:close") return this.closePanel();
    if (id === "panel:prev") return this.turnPage(-1);
    if (id === "panel:next") return this.turnPage(1);
    if (id.startsWith("menu:")) return this.onMenu(id);
    if (id.startsWith("zone:")) {
      this.scrollPage(id);
      this.scrolling = { zone: id, nextAt: (this.gaze?.t ?? 0) + this.scrollRepeatMs };
      return;
    }
    if (id.startsWith("app:")) return this.onApp(id.slice(4));
    if (id.startsWith("key:")) return this.onKey(id);
    if (id.startsWith("pick:") || id.startsWith("num:")) {
      const tid = id.slice(id.indexOf(":") + 1);
      const target =
        this.snapshot.targets.find((t) => t.id === tid) ?? this.picker?.candidates.find((t) => t.id === tid);
      this.closePanel();
      if (target) this.act(target);
      return;
    }
    if (this.cluster && id === this.cluster.id) {
      this.picker = this.cluster;
      this.attention = this.cluster.anchor;
      this.openPanel("picker");
      return;
    }
    const target = this.snapshot.targets.find((t) => t.id === id);
    if (target) this.act(target);
  }

  // ---------------------------------------------------------------- internals: gaze

  private onSample(t: number, x: number, y: number, confidence: number): void {
    this.gaze = { t, x, y, confidence };
    const p = { x, y };
    const onDisplay = contains(this.display, p);
    let hit: string | null = null;
    let scale: number | undefined;
    if (onDisplay && confidence >= 0.5) {
      const buttons = this.buttons().filter((b) => !this.paused || b.protected);
      const b = pickTarget(p, buttons, 8);
      if (b) {
        hit = b.id;
        scale = b.dwellScale;
      } else if (!this.paused && !this.isModal()) {
        hit = this.hitApp(p);
      }
    }
    if (onDisplay && !this.coverRects().some((r) => contains(r, p))) this.lastContentPoint = p;
    this.hitId = hit;
    const events = this.dwell.update({ t, x, y, confidence, targetId: hit, dwellScale: scale });
    let selected: string | null = null;
    for (const e of events) if (e.type === "activate") selected = e.targetId;
    if (selected) this.activate(selected);
    this.changed(false);
  }

  private hitApp(p: Point): string | null {
    const visible = this.visibleAppTargets();
    const decision = decidePrecision(p, visible, this.precision);
    if (decision.kind === "direct") {
      this.cluster = null;
      return decision.target?.id ?? null;
    }
    const prev = this.cluster;
    if (prev && decision.candidates.some((c) => prev.candidates.some((pc) => pc.id === c.id))) {
      const merged = [...prev.candidates];
      for (const c of decision.candidates) if (!merged.some((m) => m.id === c.id)) merged.push(c);
      this.cluster = {
        id: prev.id,
        candidates: merged.slice(0, 12),
        anchor: decision.kind === "pick" ? decision.anchor : decision.region,
        magnify: prev.magnify || decision.kind === "magnify" || merged.length > 6,
      };
    } else {
      this.cluster = {
        id: `cluster:${Math.round(p.x)}:${Math.round(p.y)}`,
        candidates: decision.candidates,
        anchor: decision.kind === "pick" ? decision.anchor : decision.region,
        magnify: decision.kind === "magnify",
      };
    }
    return this.cluster.id;
  }

  /** App targets on this display that the overlay isn't covering, minus the shell's own (it dwells itself). */
  private visibleAppTargets(): Target[] {
    const covers = this.coverRects();
    return this.snapshot.targets.filter((t) => {
      if (t.source === "overlay") return false;
      if (t.source === "shell" && !this.dwellShell) return false;
      if (!intersection(t.rect, this.display)) return false;
      const c = center(t.rect);
      return !covers.some((r) => contains(r, c));
    });
  }

  /** Rects the overlay itself paints over. */
  private coverRects(): ScreenRect[] {
    const rects = this.buttons().map((b) => b.rect);
    const pv = this.panelView();
    if (pv) rects.push(pv.rect);
    const kb = this.keyboardOpen && !this.paused ? this.keyboardFrame() : null;
    if (kb) rects.push(kb.rect);
    return rects;
  }

  private isModal(): boolean {
    return this.panel !== null && this.panel !== "scroll";
  }

  private onSwitch(t: number): void {
    const ids = this.buttons()
      .filter((b) => !this.paused || b.protected)
      .map((b) => b.id);
    // The first press starts scanning (and a press after scanning rested restarts it); later presses select.
    const started = this.scanHighlight !== null && !this.scan.isPaused;
    const changedItems = this.scan.setItems(ids, t);
    const events = started
      ? this.scan.press(t)
      : changedItems.length > 0
        ? changedItems
        : this.scan.restart(t);
    for (const e of events) {
      if (e.type === "highlight") this.scanHighlight = e.id;
      if (e.type === "select") this.activate(e.id);
    }
    this.changed(false);
  }

  // ---------------------------------------------------------------- internals: acting on app controls

  private act(target: Target): void {
    this.notice = null;
    const c = center(target.rect);
    const mode = this.pointer;
    this.pointer = "press"; // one-shot
    if (mode === "drag") {
      if (!this.dragFrom) {
        this.dragFrom = c;
        this.pointer = "drag";
        this.say(`Picked up “${target.label || target.role}”. Now look at where to drop it.`, "info");
        return;
      }
      const from = this.dragFrom;
      this.dragFrom = null;
      if (!this.host.drag) {
        this.say("Dragging isn't available yet on this Mac.", "warn");
        return;
      }
      void this.host.drag(from, c).then((r) => {
        if (!r.ok) this.say("That drag didn't work.", "warn");
      });
      return;
    }
    if (mode === "right-click") {
      void this.host.native("input.click", { x: c.x, y: c.y, button: "right" });
      return;
    }
    if (mode === "double-click") {
      void this.host.native("input.click", { x: c.x, y: c.y, count: 2 });
      return;
    }
    if (target.role === "textfield") this.focusField(target);
    void this.press(target);
  }

  private async press(target: Target): Promise<void> {
    const c = center(target.rect);
    try {
      let result: { ok: boolean; error?: string } | null = null;
      if (target.source === "ax") result = await this.host.native("ax.press", { targetId: target.id });
      else if (target.source === "web" && this.host.pressWeb) result = await this.host.pressWeb(target.id);
      if (result?.ok) return;
      const click = await this.host.native("input.click", { x: c.x, y: c.y });
      if (result && click.ok)
        this.say("That control didn't respond to a press, so AGENCY clicked it instead.", "info");
      if (!click.ok) this.say("That didn't work. Nothing was pressed.", "warn");
    } catch {
      this.say("That didn't work. Nothing was pressed.", "warn");
    }
  }

  private focusField(target: Target): void {
    if (this.field?.id !== target.id) {
      this.learnComposition();
      this.composition = "";
      this.shift = false;
    }
    this.field = target;
    this.attention = target.rect;
    if (!this.keyboardOpen) {
      this.keyboardOpen = true;
      void this.loadPhrases();
    }
    if (target.secure)
      this.say(
        "This is a password box. AGENCY never types passwords. Ask a helper, or use a passkey.",
        "warn",
      );
    this.changed(true);
  }

  // ---------------------------------------------------------------- internals: panels

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.scrolling = null;
    this.dragFrom = null;
    this.pointer = "press";
    if (paused) this.panel = null;
    this.say(paused ? "Eye control is paused. Look at Resume to start again." : "Eye control is on.", "info");
    this.changed(true);
  }

  private openPanel(kind: PanelKind | null): void {
    this.panel = kind;
    this.page = 0;
    if (kind !== "picker") this.attention = kind === null ? null : this.attention;
    if (kind === "apps") void this.loadApps();
    this.changed(true);
  }

  private closePanel(): void {
    this.panel = null;
    this.picker = null;
    this.page = 0;
    this.changed(true);
  }

  private turnPage(delta: number): void {
    this.page = Math.max(0, this.page + delta);
    this.changed(true);
  }

  private onMenu(id: string): void {
    switch (id) {
      case "menu:numbers":
        return this.openPanel("numbers");
      case "menu:scroll":
        return this.openPanel("scroll");
      case "menu:apps":
        return this.openPanel("apps");
      case "menu:right-click":
      case "menu:double-click":
      case "menu:drag":
        this.pointer = id.slice(5) as PointerMode;
        this.dragFrom = null;
        this.closePanel();
        this.say(
          this.pointer === "drag"
            ? "Drag: look at what to pick up."
            : `${this.pointer === "right-click" ? "Right-click" : "Double-click"}: look at a control.`,
          "info",
        );
        return;
      case "menu:side":
        this.railSide = this.railSide === "right" ? "left" : "right";
        this.closePanel();
        return;
    }
  }

  private async loadApps(): Promise<void> {
    try {
      const { apps } = await this.host.native("apps.list", { includeIcons: true });
      this.apps = [...apps].sort(
        (a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name),
      );
    } catch {
      this.apps = [];
      this.say("Couldn't list the apps.", "warn");
    }
    this.changed(true);
  }

  private onApp(bundleId: string): void {
    const app = this.apps.find((a) => a.bundleId === bundleId);
    this.closePanel();
    if (!app) return;
    const call = app.running
      ? this.host.native("apps.activate", { bundleId })
      : this.host.native("apps.launch", { bundleId });
    void call.then((r) => {
      if (!r.ok) this.say(`Couldn't open ${app.name}.`, "warn");
    });
  }

  private scrollPage(zoneId: string): void {
    const p = this.lastContentPoint ?? center(this.display);
    const step = Math.round(this.display.height * 0.6);
    const dir = zoneId.slice(5);
    const dx = dir === "left" ? step : dir === "right" ? -step : 0;
    const dy = dir === "up" ? step : dir === "down" ? -step : 0;
    void this.host.native("input.scroll", { x: p.x, y: p.y, dx, dy });
  }

  // ---------------------------------------------------------------- internals: keyboard

  private toggleKeyboard(): void {
    this.keyboardOpen = !this.keyboardOpen;
    if (this.keyboardOpen) void this.loadPhrases();
    else this.learnComposition();
    this.changed(true);
  }

  private async loadPhrases(): Promise<void> {
    if (!this.host.memorySuggestions) return;
    try {
      const s = await this.host.memorySuggestions("keyboard", PREDICTION_SLOTS);
      this.phrases = s.map((x) => x.label).filter((l) => l.length > 0);
      this.changed(true);
    } catch {
      this.phrases = [];
    }
  }

  private predictions(): string[] {
    if (this.field?.secure) return [];
    const { previous, prefix } = currentWord(this.composition);
    if (prefix === "" && this.composition.trim() === "" && this.phrases.length > 0) {
      return this.phrases.slice(0, PREDICTION_SLOTS);
    }
    return this.model.predict(previous, prefix, PREDICTION_SLOTS).map((p) => p.word);
  }

  private onKey(id: string): void {
    const frame = this.keyboardFrame();
    const key = frame?.keys.find((k) => k.id === id);
    if (!key) return;
    this.runKey(key.action);
  }

  private runKey(action: KeyAction): void {
    if (action.kind === "hide") {
      this.keyboardOpen = false;
      this.learnComposition();
      this.changed(true);
      return;
    }
    if (action.kind === "shift") {
      this.shift = !this.shift;
      this.changed(true);
      return;
    }
    if (action.kind === "page") {
      this.kbPage = action.page;
      this.changed(true);
      return;
    }
    if (this.field?.secure) {
      this.say(
        "This is a password box. AGENCY never types passwords. Ask a helper, or use a passkey.",
        "warn",
      );
      return;
    }
    switch (action.kind) {
      case "char": {
        const ch = this.shouldCapitalize() ? action.char.toUpperCase() : action.char;
        this.shift = false;
        this.typeText(ch);
        break;
      }
      case "space":
        this.typeText(" ");
        break;
      case "delete":
        this.composition = this.composition.slice(0, -1);
        void this.host.native("input.key", { key: "delete" });
        break;
      case "return":
        this.learnComposition();
        this.composition = "";
        void this.host.native("input.key", { key: "return" });
        break;
      case "predict": {
        const word = this.predictions()[action.slot];
        if (!word) return;
        const { prefix } = currentWord(this.composition);
        const isPhrase = this.phrases.includes(word) && this.composition.trim() === "";
        const rest = isPhrase ? word : word.slice(prefix.length);
        const cased = prefix.length === 0 && this.shouldCapitalize() ? capitalize(rest) : rest;
        this.typeText(cased + (isPhrase ? "" : " "));
        if (isPhrase)
          this.host.logSelection?.({ path: ["keyboard", word], surface: "keyboard", outcome: "chosen" });
        break;
      }
    }
    this.changed(true);
  }

  private shouldCapitalize(): boolean {
    if (this.shift) return true;
    const t = this.composition.trimEnd();
    return this.composition.length === 0 || (/[.!?]$/.test(t) && this.composition.endsWith(" "));
  }

  private typeText(text: string): void {
    this.composition += text;
    void this.host.native("input.type", { text }).then((r) => {
      if (!r.ok) {
        this.composition = this.composition.slice(0, Math.max(0, this.composition.length - text.length));
        this.say(r.error ? plainTypeError(r.error) : "Couldn't type there.", "warn");
        this.changed(true);
      }
    });
  }

  private learnComposition(): void {
    if (this.field?.secure) return;
    if (this.composition.trim()) this.model.learn(this.composition);
  }

  private keyboardFrame(): { rect: ScreenRect; keys: ReturnType<typeof placeKeyboard> } | null {
    const area = usableArea(this.display, this.railRect(), this.railSide);
    const layout = layoutKeyboard(this.kbPage, area.width - 2 * PANEL_PAD);
    const size = { width: layout.size.width + 2 * PANEL_PAD, height: layout.size.height + 2 * PANEL_PAD };
    const avoid = this.field ? [this.field.rect] : this.attention ? [this.attention] : [];
    const rect = placePanel(area, size, avoid);
    const keys = placeKeyboard(layout, { x: rect.x + PANEL_PAD, y: rect.y + PANEL_PAD });
    return { rect, keys };
  }

  private keyboardButtons(): OverlayButton[] {
    if (!this.keyboardOpen) return [];
    const frame = this.keyboardFrame();
    if (!frame) return [];
    const secure = this.field?.secure === true;
    const preds = this.predictions();
    return frame.keys
      .filter((k) => !secure || k.action.kind === "hide")
      .map((k) => {
        let label = k.label;
        if (k.action.kind === "char" && this.shouldCapitalize()) label = k.label.toUpperCase();
        if (k.action.kind === "predict") label = preds[k.action.slot] ?? "";
        return {
          id: k.id,
          rect: k.rect,
          label,
          detail: k.name,
          kind: "key" as const,
          tone: k.action.kind === "predict" ? ("accent" as const) : ("plain" as const),
          dwellScale: k.dwellScale,
          active: k.action.kind === "shift" && this.shift,
        };
      })
      .filter((b) => b.label !== "" || !b.id.startsWith("key:predict"));
  }

  // ---------------------------------------------------------------- internals: layout

  private railRect(): ScreenRect {
    return boundsOf(layoutRail(this.display, this.railSide, RAIL.length));
  }

  private railButtons(): OverlayButton[] {
    const rects = layoutRail(this.display, this.railSide, RAIL.length);
    return RAIL.map((r, i) => {
      const pause = r.id === "overlay:pause";
      return {
        id: r.id,
        rect: rects[i] as ScreenRect,
        label: pause && this.paused ? "Resume eyes" : r.label,
        kind: "rail" as const,
        tone: pause && this.paused ? ("accent" as const) : r.tone,
        protected: r.protected,
        // While paused, anything that resumes eye control takes a longer look, so a stray glance can't.
        dwellScale: this.paused && r.id !== "overlay:help" && r.id !== "overlay:stop" ? 1.5 : r.dwellScale,
        active:
          (r.id === "overlay:keyboard" && this.keyboardOpen) ||
          (r.id === "overlay:more" && this.panel === "menu"),
      };
    });
  }

  private numbered(): { n: number; t: Target }[] {
    const list = this.snapshot.targets.filter(
      (t) =>
        t.source !== "overlay" &&
        (t.source !== "shell" || this.dwellShell) &&
        intersection(t.rect, this.display),
    );
    return readingOrder(list).map((t, i) => ({ n: i + 1, t }));
  }

  private panelItems(): {
    items: OverlayButton[];
    grid: GridSpec;
    title: string;
    avoid: ScreenRect[];
  } | null {
    switch (this.panel) {
      case null:
      case "scroll":
        return null;
      case "menu":
        return {
          title: "More ways to control",
          grid: MENU_GRID,
          avoid: this.attention ? [this.attention] : [],
          items: MENU.map((m) => ({
            id: m.id,
            rect: zero(),
            label: m.label,
            detail:
              m.id === "menu:side" ? `To the ${this.railSide === "right" ? "left" : "right"}` : m.detail,
            kind: "item" as const,
            tone: "plain" as const,
          })),
        };
      case "picker": {
        const c = this.picker;
        if (!c) return null;
        return {
          title: "Which one?",
          grid: ITEM_GRID,
          avoid: [c.anchor, ...c.candidates.map((t) => t.rect)],
          items: c.candidates.map((t, i) => ({
            id: `pick:${t.id}`,
            rect: zero(),
            label: t.secure ? "Password box" : t.label || roleName(t.role),
            detail: roleName(t.role),
            kind: "item" as const,
            tone: "plain" as const,
            n: c.magnify ? i + 1 : undefined,
          })),
        };
      }
      case "numbers": {
        const all = this.numbered();
        const pageItems = paginate(all, ITEM_GRID.columns * ITEM_GRID.rows, this.page).items;
        return {
          title: "Choose a number",
          grid: ITEM_GRID,
          avoid: pageItems.map((e) => e.t.rect),
          items: all.map((e) => ({
            id: `num:${e.t.id}`,
            rect: zero(),
            label: e.t.secure ? "Password box" : e.t.label || roleName(e.t.role),
            detail: roleName(e.t.role),
            kind: "item" as const,
            tone: "plain" as const,
            n: e.n,
          })),
        };
      }
      case "apps":
        return {
          title: "Apps",
          grid: APP_GRID,
          avoid: [],
          items: this.apps.map((a) => ({
            id: `app:${a.bundleId}`,
            rect: zero(),
            label: a.name,
            detail: a.frontmost ? "In front" : a.running ? "Open" : "Not open",
            kind: "item" as const,
            tone: "plain" as const,
            iconPng: a.iconPng,
          })),
        };
    }
  }

  private panelGeometry(): {
    rect: ScreenRect;
    title: string;
    items: OverlayButton[];
    nav: OverlayButton[];
    page: number;
    pages: number;
  } | null {
    const spec = this.panelItems();
    if (!spec) return null;
    const perPage = spec.grid.columns * spec.grid.rows;
    const { items, page, pages } = paginate(spec.items, perPage, this.page);
    this.page = page;
    const g = gridSize(spec.grid);
    const size = { width: g.width + 2 * PANEL_PAD, height: TITLE_H + g.height + GAP + NAV_H + 2 * PANEL_PAD };
    const area = usableArea(this.display, this.railRect(), this.railSide);
    const rect = placePanel(area, size, spec.avoid);
    const gridBox = {
      x: rect.x + PANEL_PAD,
      y: rect.y + PANEL_PAD + TITLE_H,
      width: g.width,
      height: g.height,
    };
    const cells = layoutGrid(gridBox, spec.grid, items.length);
    const placed = items.map((b, i) => ({ ...b, rect: cells[i] as ScreenRect }));
    const navY = gridBox.y + g.height + GAP;
    const navW = (g.width - 2 * GAP) / 3;
    const nav: OverlayButton[] = [];
    const slot = (i: number): ScreenRect => ({
      x: gridBox.x + i * (navW + GAP),
      y: navY,
      width: navW,
      height: NAV_H,
    });
    if (page > 0)
      nav.push({ id: "panel:prev", rect: slot(0), label: "Previous", kind: "nav", tone: "plain" });
    nav.push({ id: "panel:close", rect: slot(1), label: "Close", kind: "nav", tone: "plain" });
    if (page < pages - 1)
      nav.push({ id: "panel:next", rect: slot(2), label: "Next", kind: "nav", tone: "plain" });
    return { rect, title: spec.title, items: placed, nav, page, pages };
  }

  private panelView(): PanelView | null {
    if (this.paused) return null;
    if (this.panel === "scroll") {
      return { kind: "scroll", rect: this.scrollCloseRect(), title: "Scroll", page: 0, pages: 1 };
    }
    const g = this.panelGeometry();
    if (!g || !this.panel) return null;
    return { kind: this.panel, rect: g.rect, title: g.title, page: g.page, pages: g.pages };
  }

  private panelButtons(): OverlayButton[] {
    if (this.panel === "scroll") return this.scrollZones();
    const g = this.panelGeometry();
    return g ? [...g.items, ...g.nav] : [];
  }

  private scrollCloseRect(): ScreenRect {
    const area = usableArea(this.display, this.railRect(), this.railSide);
    return { x: area.x + area.width / 2 - 120, y: area.y + area.height / 2 - 48, width: 240, height: 96 };
  }

  /** Edge bands for paging. Only present in scroll mode, so a glance at an edge never scrolls by itself. */
  private scrollZones(): OverlayButton[] {
    const a = usableArea(this.display, this.railRect(), this.railSide);
    const band = 112;
    const long = (len: number) => Math.min(len - 2 * (band + GAP), 640);
    const h = long(a.width);
    const v = long(a.height);
    return [
      {
        id: "zone:up",
        rect: { x: a.x + (a.width - h) / 2, y: a.y, width: h, height: band },
        label: "Page up",
        kind: "zone",
      },
      {
        id: "zone:down",
        rect: { x: a.x + (a.width - h) / 2, y: a.y + a.height - band, width: h, height: band },
        label: "Page down",
        kind: "zone",
      },
      {
        id: "zone:left",
        rect: { x: a.x, y: a.y + (a.height - v) / 2, width: band, height: v },
        label: "Left",
        kind: "zone",
      },
      {
        id: "zone:right",
        rect: { x: a.x + a.width - band, y: a.y + (a.height - v) / 2, width: band, height: v },
        label: "Right",
        kind: "zone",
      },
      {
        id: "panel:close",
        rect: this.scrollCloseRect(),
        label: "Stop scrolling",
        kind: "nav",
        tone: "plain",
      },
    ];
  }

  private mapView(): OverlayView["map"] {
    if (this.panel !== "picker" || !this.picker?.magnify) return null;
    const g = this.panelGeometry();
    if (!g) return null;
    const region = this.picker.anchor;
    const area = usableArea(this.display, this.railRect(), this.railSide);
    const zoom = Math.min(4, Math.max(2, 320 / Math.max(region.width, region.height)));
    const size = { width: region.width * zoom, height: region.height * zoom };
    const rect = placePanel(area, size, [g.rect, region]);
    const boxes = this.picker.candidates.map((t, i) => ({
      n: i + 1,
      rect: {
        x: rect.x + (t.rect.x - region.x) * zoom,
        y: rect.y + (t.rect.y - region.y) * zoom,
        width: t.rect.width * zoom,
        height: t.rect.height * zoom,
      },
    }));
    return { rect, region, boxes };
  }

  // ---------------------------------------------------------------- plumbing

  private say(text: string, tone: Notice["tone"]): void {
    this.notice = { text, tone };
    this.changed(false);
  }

  private changed(layout: boolean): void {
    if (layout) {
      this.cachedButtons = null;
      const rects = this.buttons().map((b) => b.rect);
      const pv = this.panelView();
      if (pv) rects.push(pv.rect);
      const kb = this.keyboardOpen && !this.paused ? this.keyboardFrame() : null;
      if (kb) rects.push(kb.rect);
      this.host.setInteractiveRegions?.(rects);
    }
    this.version++;
    for (const l of this.listeners) l();
  }

  /** For tests and the debug HUD: which id the gaze is on right now. */
  get currentHit(): string | null {
    return this.hitId;
  }

  get currentComposition(): string {
    return this.field?.secure ? "" : this.composition;
  }
}

function zero(): ScreenRect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ROLE_NAMES: Record<string, string> = {
  button: "Button",
  link: "Link",
  textfield: "Text box",
  checkbox: "Checkbox",
  radio: "Option",
  menuitem: "Menu item",
  tab: "Tab",
  cell: "Row",
  popup: "Menu",
  slider: "Slider",
};

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

function plainTypeError(error: string): string {
  if (/secure|password/i.test(error)) return "This is a password box. AGENCY never types passwords.";
  if (/stop/i.test(error)) return "Typing was stopped.";
  if (/permission|accessibility/i.test(error))
    return "AGENCY needs Accessibility permission to type into other apps.";
  return "Couldn't type there.";
}
