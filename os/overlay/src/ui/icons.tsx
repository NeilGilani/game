/**
 * Icons from the AGENCY OS design system (docs/os/DESIGN.md): Lucide at a 2.25 stroke, the same glyphs the
 * shell's dock uses (Bell for Help, Square for Stop, House, Keyboard, Pause/Play). Decorative: the text next to
 * them carries the meaning.
 */
import {
  ArrowBigUp,
  ArrowLeftRight,
  ArrowUpDown,
  Bell,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CornerDownLeft,
  Delete,
  Ellipsis,
  Hash,
  House,
  Info,
  Keyboard,
  LayoutGrid,
  MousePointer2,
  MousePointerClick,
  Move,
  Pause,
  Play,
  Square,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

const RAIL: Record<string, LucideIcon> = {
  "overlay:help": Bell,
  "overlay:stop": Square,
  "overlay:home": House,
  "overlay:keyboard": Keyboard,
  "overlay:more": Ellipsis,
  "overlay:pause": Pause,
};

const MENU: Record<string, LucideIcon> = {
  "menu:numbers": Hash,
  "menu:scroll": ArrowUpDown,
  "menu:apps": LayoutGrid,
  "menu:right-click": MousePointerClick,
  "menu:double-click": MousePointer2,
  "menu:drag": Move,
  "menu:side": ArrowLeftRight,
};

const NAV: Record<string, LucideIcon> = {
  "panel:prev": ChevronLeft,
  "panel:next": ChevronRight,
  "panel:close": X,
  "key:delete": Delete,
  "key:return": CornerDownLeft,
  "key:shift": ArrowBigUp,
};

const NOTICE: Record<string, LucideIcon> = { warn: TriangleAlert, ok: CircleCheck, info: Info };

function Glyph({ icon: G, size }: { icon: LucideIcon | undefined; size: number }) {
  return G ? <G className="ico" size={size} strokeWidth={2.25} aria-hidden="true" focusable="false" /> : null;
}

export function RailIcon({ id, paused }: { id: string; paused: boolean }) {
  return <Glyph icon={id === "overlay:pause" && paused ? Play : RAIL[id]} size={30} />;
}

export function MenuIcon({ id }: { id: string }) {
  return MENU[id] ? <Glyph icon={MENU[id]} size={28} /> : null;
}

export function NavIcon({ id }: { id: string }) {
  return <Glyph icon={NAV[id]} size={26} />;
}

export function hasNavIcon(id: string): boolean {
  return id in NAV;
}

export function NoticeIcon({ tone }: { tone: string }) {
  return <Glyph icon={NOTICE[tone]} size={24} />;
}
