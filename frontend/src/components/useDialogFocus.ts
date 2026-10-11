import { useEffect, useRef, type RefObject } from "react";
import { SELECTION_RESET_EVENT } from "./common";

/** Keep keyboard focus in the topmost dialog and return it to the invoking control.
 * Gaze/switch targets still use the existing modal scope and selection pause. */
export function useDialogFocus(ref: RefObject<HTMLDivElement | null>, onDismiss?: () => void) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length && !el.closest("[inert], [hidden]"));
    dialog.tabIndex = -1;
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? controls()[0] ?? dialog).focus({
      preventScroll: true,
    });
    window.dispatchEvent(new Event(SELECTION_RESET_EVENT));
    const onKey = (e: KeyboardEvent) => {
      const top = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
        .filter((el) => el.getClientRects().length)
        .at(-1);
      if (top !== dialog) return;
      if (e.key === "Escape" && dismiss.current) {
        e.preventDefault();
        e.stopPropagation();
        dismiss.current();
      } else if (e.key === "Tab") {
        const elements = controls();
        const first = elements[0];
        const last = elements.at(-1);
        if (
          !first ||
          !dialog.contains(document.activeElement) ||
          (e.shiftKey && document.activeElement === first) ||
          (!e.shiftKey && document.activeElement === last) ||
          document.activeElement === dialog
        ) {
          e.preventDefault();
          (e.shiftKey ? (last ?? dialog) : (first ?? dialog)).focus({ preventScroll: true });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [ref]);
}
