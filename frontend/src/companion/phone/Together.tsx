/** Send a message or photo to the person's screen, and the carers' hand-over notes. */
import { useCallback, useEffect, useRef, useState } from "react";
import { phoneApi, shrinkPhoto, when, type Note, type SentMessage } from "./phoneApi";

export function SendScreen() {
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [sent, setSent] = useState<SentMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    void phoneApi.messages().then(setSent, () => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const pick = async (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!f.type.startsWith("image/")) return setError("Choose a photo.");
    try {
      setPhoto(await shrinkPhoto(f));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That photo couldn't be used.");
    }
  };

  const send = async () => {
    setError(null);
    setDone(null);
    if (!text.trim() && !photo) return setError("Write a few words or add a photo.");
    setBusy(true);
    try {
      await phoneApi.send(text.trim(), photo);
      setText("");
      setPhoto(null);
      if (file.current) file.current.value = "";
      setDone("Sent. It shows big on the screen until it's seen.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't send.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ph-stack">
      <h1>Send a message</h1>
      <p className="ph-muted">It appears big on the AGENCY screen, with your name.</p>
      <form
        className="ph-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="ph-field">
          <span>Message</span>
          <textarea
            value={text}
            maxLength={280}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            placeholder="Back at 6 with dinner"
          />
        </label>
        <label className="ph-btn ph-quiet ph-file">
          {photo ? "Choose a different photo" : "Add a photo"}
          <input ref={file} type="file" accept="image/*" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        {photo && (
          <div className="ph-preview">
            <img src={photo} alt="The photo you're sending" />
            <button type="button" className="ph-btn ph-quiet" onClick={() => setPhoto(null)}>
              Remove photo
            </button>
          </div>
        )}
        {error && (
          <p className="ph-error" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p className="ph-ok" role="status">
            {done}
          </p>
        )}
        <button className="ph-btn ph-primary" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send to the screen"}
        </button>
      </form>
      {sent.length > 0 && (
        <section className="ph-card" aria-label="Sent from this phone">
          <h2>Sent from this phone</h2>
          <ul className="ph-list">
            {sent.map((m) => (
              <li key={m.id}>
                <b>{when(m.created_at)}</b> {m.text || "(photo)"}
                {m.has_photo && m.text ? " + photo" : ""}
                <span className="ph-sub">{m.seen_at ? `Seen at ${when(m.seen_at)}` : "Not seen yet"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function NotesScreen() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void phoneApi.notes().then(setNotes, () => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load]);
  const save = async () => {
    setError(null);
    if (!text.trim()) return setError("Write something first.");
    setBusy(true);
    try {
      await phoneApi.addNote(text);
      setText("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ph-stack">
      <h1>Hand-over notes</h1>
      <p className="ph-muted">For the next carer. Kept on the Mac, and everyone paired can read them.</p>
      <form
        className="ph-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="ph-field">
          <span>New note</span>
          <textarea
            value={text}
            maxLength={2000}
            rows={4}
            onChange={(e) => setText(e.target.value)}
            placeholder="Slept well. Mask refitted at 6. Needs water."
          />
        </label>
        {error && (
          <p className="ph-error" role="alert">
            {error}
          </p>
        )}
        <button className="ph-btn ph-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save note"}
        </button>
      </form>
      <ul className="ph-notes" aria-label="Notes">
        {notes.map((n) => (
          <li key={n.id} className="ph-card">
            <b>{n.author}</b> <span className="ph-muted">{when(n.created_at)}</span>
            <p className="ph-note-text">{n.text}</p>
          </li>
        ))}
        {notes.length === 0 && <li className="ph-muted">No notes yet.</li>}
      </ul>
    </div>
  );
}
