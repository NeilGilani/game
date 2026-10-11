/** The native rail shares AGENCY's original artwork. Help and Stop stay plain and immediate. */
import { AppIcon, Icon } from "../../../../frontend/src/components/Icon";

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
  return name === "home" || name === "keyboard" || name === "grid" ? (
    <AppIcon name={name} size={36} />
  ) : (
    <Icon name={name} size={24} />
  );
}
