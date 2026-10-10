import { useSyncExternalStore } from "react";
import type { OverlayController } from "../core/controller";
import { Overlay } from "./Overlay";

export function OverlayApp({ ctrl }: { ctrl: OverlayController }) {
  useSyncExternalStore(
    (l) => ctrl.subscribe(l),
    () => ctrl.getVersion(),
  );
  return <Overlay view={ctrl.view()} onActivate={(id) => ctrl.activate(id)} />;
}
