/**
 * The eye keyboard: whenever a text box gets focus (by a look, a click or the dock's Keyboard button), big keys
 * appear at the bottom of the screen. Every key is a dwell target, so a person types with their eyes; the keys
 * never take focus away from the text box. Password fields never get it (AGENCY doesn't handle passwords).
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
/** The "123" keys: digits, then what addresses, emails and phone numbers need. As few keys as letters, as big. */
export const SYMBOL_ROWS = ["1234567890", "@-_/:.,+", "#&'!?()"];
const TEXT_TYPES = new Set(["", "text", "search", "email", "tel", "url", "number"]);

/** Phone numbers, PINs and other numbers start on the digits. */
export function startsWithDigits(f: { type: string; inputMode: string }): boolean {
  return f.type === "tel" || f.type === "number" || ["tel", "numeric", "decimal"].includes(f.inputMode);
}

type Field = HTMLInputElement | HTMLTextAreaElement;

function typable(el: EventTarget | null): el is Field {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

/** The text box the keyboard is typing into (null while it's closed). */
let typingInto: Field | null = null;

/**
 * The text box after the one being typed into, else the first, in `root`: each look at the dock's Keyboard button
 * moves on to the next box, so every box on a screen with several can be reached with the eyes.
 */
export function nextTextField(root: ParentNode): Field | null {
  const fields = [...root.querySelectorAll("input, textarea")].filter(
    (f): f is Field => typable(f) && f.getClientRects().length > 0,
  );
  if (!fields.length) return null;
  const current = fields.find((f) => f === typingInto) ?? fields.find((f) => f === document.activeElement);
  return fields[current ? (fields.indexOf(current) + 1) % fields.length : 0]!;
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
  const [symbols, setSymbols] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (typable(e.target)) {
        setField(e.target);
        setText(e.target.value);
        setSymbols(startsWithDigits(e.target));
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
    typingInto = field;
  }, [field]);

  if (!field) return null;

  const put = (value: string) => {
    setValue(field, value);
    setText(value);
  };
  const add = (s: string) => {
    // A value set from code isn't held to the box's maxlength, so keep to it here.
    if (field.maxLength > 0 && field.value.length >= field.maxLength) return;
    put(field.value + s);
  };
  const type = (s: string) => {
    add(caps ? s.toUpperCase() : s);
    setCaps(false);
  };
  const toggleSymbols = (
    <button
      className="eye-key eye-key-wide"
      onClick={() => setSymbols((on) => !on)}
      data-dwell
      aria-label={symbols ? "Letters" : "Numbers and symbols"}
    >
      {symbols ? "ABC" : "123"}
    </button>
  );
  const del = () => put(field.value.slice(0, -1));
  const done = () => {
    if (field instanceof HTMLInputElement && field.form) field.form.requestSubmit();
    field.blur();
    setField(null);
  };
  // Keys keep the focus in the text box (a mouse press would otherwise move it to the key).
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div
      ref={ref}
      className="eye-keyboard"
      role="group"
      aria-label="Eye keyboard"
      onMouseDown={keep}
      // Typing into a dialog: eye control, limited to the dialog, keeps these keys choosable too.
      data-keyboard-for={field.closest('[data-dwell-scope="modal"]') ? "modal" : undefined}
    >
      <div className="eye-keyboard-preview" aria-live="polite">
        {text || <span className="muted">Look at the letters to type</span>}
        <span className="eye-keyboard-caret" aria-hidden />
      </div>
      {/* "123" sits at the end of the last row (letters: z…m; symbols: # & …), so no row gets more keys. */}
      {(symbols ? SYMBOL_ROWS : ROWS).map((row, i, rows) => (
        <div className="eye-keyboard-row" key={row}>
          {[...row].map((k) =>
            symbols ? (
              <button key={k} className="eye-key" onClick={() => add(k)} data-dwell>
                {k}
              </button>
            ) : (
              <button key={k} className="eye-key" onClick={() => type(k)} data-dwell>
                {caps ? k.toUpperCase() : k}
              </button>
            ),
          )}
          {i === rows.length - 1 && toggleSymbols}
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
