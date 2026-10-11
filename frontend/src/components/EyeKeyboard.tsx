/**
 * The eye keyboard: whenever a text box gets focus (by a look, a click or the dock's Keyboard button), big keys
 * appear at the bottom of the screen. Every key is a dwell target, so a person types with their eyes; the keys
 * never take focus away from the text box. Password fields never get it (AGENCY doesn't handle passwords).
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const TEXT_TYPES = new Set(["", "text", "search", "email", "tel", "url"]);

type Field = HTMLInputElement | HTMLTextAreaElement;

function typable(el: EventTarget | null): el is Field {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

/** Set the value the way a person typing would, so React-controlled fields see the change. */
function setValue(el: Field, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function EyeKeyboard() {
  const [field, setField] = useState<Field | null>(null);
  const [text, setText] = useState("");
  const [caps, setCaps] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (typable(e.target)) {
        setField(e.target);
        setText(e.target.value);
        setCaps(e.target.value.trim() === "" || /[.!?]\s*$/.test(e.target.value));
        e.target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };
    const onInput = (e: Event) => {
      if (e.target === field && field) setText(field.value);
    };
    const close = () => setField(null);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("input", onInput, true);
    window.addEventListener("hashchange", close);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("input", onInput, true);
      window.removeEventListener("hashchange", close);
    };
  }, [field]);

  // The text box went away (its screen changed): the keyboard goes too.
  useEffect(() => {
    if (!field) return;
    const t = setInterval(() => {
      if (!field.isConnected) setField(null);
    }, 500);
    return () => clearInterval(t);
  }, [field]);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-eye-keyboard", !!field);
  }, [field]);

  if (!field) return null;

  const put = (value: string) => {
    setValue(field, value);
    setText(value);
  };
  const type = (s: string) => {
    put(field.value + (caps ? s.toUpperCase() : s));
    setCaps(false);
  };
  const del = () => put(field.value.slice(0, -1));
  const done = () => {
    if (field instanceof HTMLInputElement && field.form) field.form.requestSubmit();
    field.blur();
    setField(null);
  };
  // Keys keep the focus in the text box (a mouse press would otherwise move it to the key).
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div ref={ref} className="eye-keyboard" role="group" aria-label="Eye keyboard" onMouseDown={keep}>
      <div className="eye-keyboard-preview" aria-live="polite">
        {text || <span className="muted">Look at the letters to type</span>}
        <span className="eye-keyboard-caret" aria-hidden />
      </div>
      {ROWS.map((row) => (
        <div className="eye-keyboard-row" key={row}>
          {[...row].map((k) => (
            <button key={k} className="eye-key" onClick={() => type(k)} data-dwell>
              {caps ? k.toUpperCase() : k}
            </button>
          ))}
        </div>
      ))}
      <div className="eye-keyboard-row">
        <button
          className="eye-key eye-key-wide"
          onClick={() => setCaps((c) => !c)}
          data-dwell
          aria-pressed={caps}
        >
          Aa
        </button>
        <button className="eye-key" onClick={() => type(".")} data-dwell>
          .
        </button>
        <button className="eye-key" onClick={() => type("?")} data-dwell>
          ?
        </button>
        <button className="eye-key eye-key-space" onClick={() => type(" ")} data-dwell>
          Space
        </button>
        <button className="eye-key eye-key-wide" onClick={del} data-dwell aria-label="Delete">
          <Icon name="back" /> Delete
        </button>
        <button className="eye-key eye-key-wide" onClick={() => put("")} data-dwell>
          Clear
        </button>
        <button className="eye-key eye-key-wide eye-key-done" onClick={done} data-dwell>
          Done
        </button>
      </div>
    </div>
  );
}
