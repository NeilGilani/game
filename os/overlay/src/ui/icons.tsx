/**
 * Icons from the AGENCY OS design system: the shell's own artwork (frontend/src/components/Icon.tsx), so the rail,
 * menu and notices look exactly like the shell's dock and choices. Flat glyphs for small controls, sculpted art at
 * feature sizes. Decorative: the text next to them carries the meaning.
 */
import { AppIcon, Icon } from "../../../../frontend/src/components/Icon";

const MENU: Record<string, string> = {
  "menu:numbers": "list",
  "menu:scroll": "down",
  "menu:apps": "grid",
  "menu:right-click": "pointer",
  "menu:double-click": "target",
  "menu:drag": "hand",
  "menu:side": "refresh",
};

const NAV: Record<string, string> = {
  "panel:prev": "left",
  "panel:next": "right",
  "panel:close": "x",
  "key:delete": "back",
};

const NOTICE: Record<string, string> = { warn: "alert", ok: "check", info: "info" };

export function RailIcon({ id, paused }: { id: string; paused: boolean }) {
  const name = {
    "overlay:help": "alert",
    "overlay:stop": "stop",
    "overlay:home": "home",
    "overlay:keyboard": "keyboard",
    "overlay:more": "grid",
    "overlay:pause": paused ? "play" : "pause",
  }[id];
  if (!name) return null;
  // Help and Stop stay plain and immediate; the others use the dock's sculpted art.
  return name === "home" || name === "keyboard" || name === "grid" ? (
    <AppIcon name={name} size={36} />
  ) : (
    <Icon name={name} size={24} />
  );
}

/** A choice's icon plate, like the shell's flow choices (sculpted art at plate size). */
export function MenuIcon({ id }: { id: string }) {
  return MENU[id] ? <AppIcon name={MENU[id]} size={52} /> : null;
}

export function NavIcon({ id }: { id: string }) {
  return NAV[id] ? <Icon name={NAV[id]} size={24} /> : null;
}

export function hasNavIcon(id: string): boolean {
  return id in NAV;
}

export function NoticeIcon({ tone }: { tone: string }) {
  return <Icon name={NOTICE[tone] ?? "info"} size={22} />;
}
