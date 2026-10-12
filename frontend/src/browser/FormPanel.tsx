/**
 * Typing into a page with the eyes: AGENCY's eye keyboard types into a box here, and every letter goes straight into
 * the page's own text box, which stays in view above the keyboard. A bar just above the keyboard has word
 * predictions and big Previous box, Next box, Submit and Done. Password, code and card boxes never get the keyboard:
 * a helper types those.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WordModel, applyWord } from "../../../os/tasks/src/index";
import { Icon } from "../components/Icon";
import { useHistory } from "../talk/storage";
import type { BrowserApi, ConsequentialKind, PageField } from "./store";

const TYPED_KEY = "agency.browser.typed";

/** What the person typed into pages (never passwords), for word predictions. Cleared with the history. */
export function typedHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TYPED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  } catch {
    return [];
  }
}

function rememberTyped(text: string): void {
  const t = text.trim();
  if (t.length < 2) return;
  try {
    localStorage.setItem(
      TYPED_KEY,
      JSON.stringify([t, ...typedHistory().filter((x) => x !== t)].slice(0, 200)),
    );
  } catch {
    /* storage unavailable: predictions just don't learn this one */
  }
}

export function forgetTyped(): void {
  try {
    localStorage.removeItem(TYPED_KEY);
  } catch {
    /* ignore */
  }
}

/** Where the bar goes: just above the eye keyboard when it is open, else above the dock. */
function useKeyboardTop(): number | null {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => {
      const kb = document.querySelector(".eye-keyboard");
      const next = kb ? Math.round(kb.getBoundingClientRect().top) : null;
      setTop((cur) => (cur === next ? cur : next));
    }, 150);
    return () => window.clearInterval(t);
  }, []);
  return top;
}

export function FormPanel({
  api,
  form,
  onField,
  onConfirm,
  onDone,
}: {
  api: BrowserApi;
  form: { tabId: number; field: PageField };
  onField: (f: PageField) => void;
  onConfirm: (action: ConsequentialKind) => void;
  onDone: (navigated: boolean) => void;
}) {
  const f = form.field;
  const [value, setValue] = useState(f.value);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const pending = useRef<number | null>(null);
  const history = useHistory();
  const kbTop = useKeyboardTop();

  useEffect(() => {
    setValue(f.value);
    if (!f.secure) input.current?.focus();
    // Once the keyboard is up (and the page view smaller), bring the box back into the middle of the view.
    const t = window.setTimeout(() => void api.field(form.tabId, f.ref, { op: "show" }), 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.ref]);

  const model = useMemo(
    () => new WordModel([...typedHistory(), ...history.items.map((h) => h.text)]),
    [history.items],
  );
  const words = f.secure ? [] : model.next(value, 3);

  const push = (v: string) => {
    if (pending.current) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      void api.field(form.tabId, f.ref, { op: "set", value: v });
    }, 60);
  };
  const change = (v: string) => {
    setValue(v);
    push(v);
  };
  const flush = async () => {
    if (pending.current) {
      window.clearTimeout(pending.current);
      pending.current = null;
      if (!f.secure) await api.field(form.tabId, f.ref, { op: "set", value });
    }
  };
  const move = async (op: "next" | "previous") => {
    await flush();
    rememberTyped(value);
    const r = await api.field(form.tabId, f.ref, { op });
    if (r.kind === "field") onField(r.field);
  };
  const submit = async () => {
    await flush();
    rememberTyped(value);
    const r = await api.field(form.tabId, f.ref, { op: "submit" });
    if (r.kind === "confirm") onConfirm(r.action);
    else if (r.kind === "done") onDone(r.navigated);
  };
  const done = async () => {
    await flush();
    rememberTyped(value);
    input.current?.blur();
    onDone(false);
  };

  const bottom = kbTop !== null ? window.innerHeight - kbTop + 10 : undefined;
  return createPortal(
    <div
      className="bw-formbar"
      style={bottom !== undefined ? { bottom } : undefined}
      role="group"
      aria-label={`Typing in: ${f.label}`}
      onMouseDown={(e) => {
        // Keep the typing box focused (the eye keyboard stays open) when a helper clicks the bar.
        if (e.target !== input.current) e.preventDefault();
      }}
    >
      <div className="bw-formbar-field">
        <span className="bw-formbar-kicker">{f.secure ? "Password box" : "Typing in"}</span>
        <span className="bw-formbar-label">{f.label}</span>
        {f.type === "multiline" ? (
          <textarea
            ref={input}
            className="bw-form-input"
            value={value}
            onChange={(e) => change(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            aria-label={f.label}
            disabled={f.secure}
          />
        ) : (
          !f.secure && (
            <input
              ref={input}
              className="bw-form-input"
              type={
                f.type === "email"
                  ? "email"
                  : f.type === "tel"
                    ? "tel"
                    : f.type === "number"
                      ? "number"
                      : f.type === "url"
                        ? "url"
                        : "text"
              }
              value={value}
              maxLength={f.maxLength ?? undefined}
              onChange={(e) => change(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              aria-label={f.label}
              autoComplete="off"
            />
          )
        )}
      </div>
      {f.secure ? (
        <p className="bw-formbar-secure">
          <Icon name="lock" size={22} flat /> AGENCY never types passwords, codes or card numbers. A helper
          can type it here with a keyboard.
        </p>
      ) : (
        <>
          {words.map((w) => (
            <button
              key={w.text}
              className="bw-formbar-word"
              onClick={() => change(applyWord(value, w.text))}
              data-dwell
            >
              {w.text}
            </button>
          ))}
          {!focused && (
            <button className="bw-formbar-btn" onClick={() => input.current?.focus()} data-dwell>
              <Icon name="keyboard" size={24} flat /> Keyboard
            </button>
          )}
        </>
      )}
      <span className="bw-formbar-gap" />
      {f.hasPrevious && (
        <button className="bw-formbar-btn" onClick={() => void move("previous")} data-dwell>
          <Icon name="left" size={24} /> Previous box
        </button>
      )}
      {f.hasNext && (
        <button className="bw-formbar-btn" onClick={() => void move("next")} data-dwell>
          Next box <Icon name="right" size={24} />
        </button>
      )}
      {f.submitLabel && !f.secure && (
        <button className="bw-formbar-btn bw-formbar-submit" onClick={() => void submit()} data-dwell>
          <Icon name="check" size={24} /> {f.submitLabel}
        </button>
      )}
      <button className="bw-formbar-btn" onClick={() => void done()} data-dwell>
        Done
      </button>
    </div>,
    document.body,
  );
}
