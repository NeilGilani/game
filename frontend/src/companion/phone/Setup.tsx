/**
 * Setting AGENCY up from the phone: Lifeline contacts, the person's details for forms, Talk phrases, favourite
 * sites, the Papers folder and safety settings. Every change is shown on the person's screen with the carer's name.
 * A change that makes the person less safe, or adds a real phone number, waits for the person to allow it.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  contactId,
  phoneApi,
  when,
  type Change,
  type Channel,
  type Contact,
  type ContactRole,
  type Details,
  type Safety,
  type Setup,
} from "./phoneApi";

const SECTIONS: { id: string; label: string; sub: (s: Setup) => string }[] = [
  {
    id: "contacts",
    label: "Lifeline contacts",
    sub: (s) => s.contacts.map((c) => c.name).join(", ") || "Nobody yet",
  },
  {
    id: "safety",
    label: "Safety",
    sub: (s) =>
      `Watch over me ${s.safety.watch ? "on" : "off"} · check-ins ${
        s.safety.checkin_interval_min ? `every ${s.safety.checkin_interval_min} min` : "off"
      }`,
  },
  { id: "phrases", label: "Talk phrases", sub: (s) => `${s.mac.phrases.length} from carers` },
  {
    id: "sites",
    label: "Favourite sites",
    sub: (s) => s.mac.favourites.map((f) => f.title).join(", ") || "None",
  },
  {
    id: "details",
    label: "Details for forms",
    sub: (s) => (s.mac.details?.fullName ? s.mac.details.fullName : "Not filled in"),
  },
  { id: "papers", label: "Papers folder", sub: (s) => s.mac.papers_folder?.display ?? "Not chosen" },
];

const STATUS: Record<Change["status"], string> = {
  applied: "Done. It shows on the AGENCY screen.",
  waiting_person: "Sent. This waits for the person to allow it on their screen.",
  waiting_mac: "Sent to the Mac. It's applied in a few seconds.",
  declined: "The person didn't allow this change.",
  failed: "The Mac couldn't apply this.",
  replaced: "A newer change replaced this one.",
  unchanged: "Nothing changed.",
};

function useSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setSetup(await phoneApi.setup());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Can't reach AGENCY.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { setup, error, reload: load };
}

export function SetupScreen({ section, onForgotten }: { section: string; onForgotten: () => void }) {
  const { setup, error, reload } = useSetup();
  if (!setup) return <p>{error ?? "Loading…"}</p>;
  const props = { setup, reload };
  if (section === "contacts") return <ContactsSection {...props} />;
  if (section === "safety") return <SafetySection {...props} />;
  if (section === "phrases") return <PhrasesSection {...props} />;
  if (section === "sites") return <SitesSection {...props} />;
  if (section === "details") return <DetailsSection {...props} />;
  if (section === "papers") return <PapersSection {...props} />;
  return (
    <div className="ph-stack">
      <h1>Set up AGENCY</h1>
      {setup.open.length > 0 && (
        <section className="ph-card" aria-label="Waiting">
          <h2>Waiting</h2>
          <ul className="ph-list">
            {setup.open.map((c) => (
              <li key={c.id}>
                {c.summary}
                <span className="ph-sub">
                  {c.author}, {when(c.created_at)} ·{" "}
                  {c.status === "waiting_person" ? "waiting for the person" : "being applied"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="ph-menu">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a className="ph-menu-item" href={`#/setup/${s.id}`}>
              <span className="ph-menu-label">{s.label}</span>
              <span className="ph-sub">{s.sub(setup)}</span>
            </a>
          </li>
        ))}
      </ul>
      {!setup.mac.known && (
        <p className="ph-muted">
          The AGENCY screen hasn&apos;t shared its phrases, sites and details yet. Make sure AGENCY is open on
          the Mac.
        </p>
      )}
      <Forget onForgotten={onForgotten} />
    </div>
  );
}

function Forget({ onForgotten }: { onForgotten: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <section className="ph-card" aria-label="This phone">
      <h2>This phone</h2>
      {sure ? (
        <div className="ph-stack">
          <p>Unpair this phone? You&apos;ll need a new code from the Mac to connect again.</p>
          <button
            className="ph-btn ph-danger"
            onClick={() =>
              void phoneApi.forget().finally(() => {
                onForgotten();
              })
            }
          >
            Yes, unpair this phone
          </button>
          <button className="ph-btn ph-quiet" onClick={() => setSure(false)}>
            No, keep it
          </button>
        </div>
      ) : (
        <button className="ph-btn ph-quiet" onClick={() => setSure(true)}>
          Unpair this phone
        </button>
      )}
    </section>
  );
}

interface SectionProps {
  setup: Setup;
  reload: () => Promise<void>;
}

/** Shared frame for one section: title, body, a Save button and what happened. */
function Section({
  title,
  intro,
  children,
  onSave,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  onSave: () => Promise<Change>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Change | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await onSave());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ph-stack">
      <a className="ph-back" href="#/setup">
        ‹ Set up
      </a>
      <h1>{title}</h1>
      {intro && <div className="ph-muted">{intro}</div>}
      <form
        className="ph-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {children}
        {error && (
          <p className="ph-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className={result.status === "applied" ? "ph-ok" : "ph-note"} role="status">
            {STATUS[result.status]}
            {result.summary && result.status !== "unchanged" ? ` (${result.summary})` : ""}
          </p>
        )}
        <button className="ph-btn ph-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

// -- contacts ----------------------------------------------------------------------------------------

const ROLES: [ContactRole, string][] = [
  ["caregiver", "Caregiver"],
  ["family", "Family"],
  ["neighbour", "Neighbour"],
  ["clinician", "Clinician"],
  ["monitoring_service", "Monitoring service"],
  ["other", "Other"],
];
const CHANNELS: [Channel, string][] = [
  ["demo", "Practice phone (simulated)"],
  ["sms", "Real text messages"],
  ["sms_call", "Real texts and a phone call"],
];

function ContactsSection({ setup, reload }: SectionProps) {
  const [list, setList] = useState<Contact[]>(setup.contacts);
  const set = (i: number, patch: Partial<Contact>) =>
    setList((l) => l.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () =>
    setList((l) => [
      ...l,
      {
        id: contactId(
          `new_${l.length + 1}`,
          l.map((c) => c.id),
        ),
        name: "",
        role: "family",
        channel: "demo",
        address: "",
        priority: Math.min(9, Math.max(1, ...l.map((c) => c.priority)) + 1),
        enabled: true,
      },
    ]);
  return (
    <Section
      title="Lifeline contacts"
      intro={
        <p>
          The people Lifeline contacts, in order (1 first; the same number means together). Adding a real
          phone number or removing someone waits for the person to allow it.
        </p>
      }
      onSave={async () => {
        const taken: string[] = [];
        const contacts = list.map((c) => {
          const fresh = !setup.contacts.some((o) => o.id === c.id);
          const id = fresh
            ? contactId(c.name || "person", [...setup.contacts.map((o) => o.id), ...taken])
            : c.id;
          taken.push(id);
          return { ...c, id, name: c.name.trim(), address: c.address.replace(/\s+/g, "") };
        });
        const r = await phoneApi.change("contacts", { contacts });
        setList(contacts); // keep the ids just given to new people, so the next save edits them
        await reload();
        return r;
      }}
    >
      {list.map((c, i) => (
        <fieldset key={c.id} className="ph-card ph-fieldset">
          <legend>{c.name || "New person"}</legend>
          <label className="ph-field">
            <span>Name</span>
            <input
              value={c.name}
              maxLength={60}
              required
              onChange={(e) => set(i, { name: e.target.value })}
            />
          </label>
          <label className="ph-field">
            <span>Who they are</span>
            <select value={c.role} onChange={(e) => set(i, { role: e.target.value as ContactRole })}>
              {ROLES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="ph-field">
            <span>How Lifeline reaches them</span>
            <select value={c.channel} onChange={(e) => set(i, { channel: e.target.value as Channel })}>
              {CHANNELS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {c.channel !== "demo" && (
            <label className="ph-field">
              <span>Phone number, with country code</span>
              <input
                type="tel"
                inputMode="tel"
                placeholder="+14155550123"
                maxLength={20}
                value={c.address}
                onChange={(e) => set(i, { address: e.target.value })}
              />
            </label>
          )}
          <label className="ph-field">
            <span>Order</span>
            <select value={c.priority} onChange={(e) => set(i, { priority: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="ph-check">
            <input
              type="checkbox"
              checked={c.enabled}
              onChange={(e) => set(i, { enabled: e.target.checked })}
            />
            Contact them in an alert
          </label>
          <button
            type="button"
            className="ph-btn ph-quiet"
            onClick={() => setList((l) => l.filter((_, j) => j !== i))}
          >
            Remove {c.name || "this person"}
          </button>
        </fieldset>
      ))}
      {list.length < 8 && (
        <button type="button" className="ph-btn ph-quiet" onClick={add}>
          + Add a person
        </button>
      )}
    </Section>
  );
}

// -- safety ------------------------------------------------------------------------------------------

function Choice<T extends number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  const known = options.some(([v]) => v === value);
  return (
    <label className="ph-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value) as T)}>
        {!known && <option value={value}>{value}</option>}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function SafetySection({ setup, reload }: SectionProps) {
  const [s, setS] = useState<Safety>(setup.safety);
  return (
    <Section
      title="Safety"
      intro={
        <p>
          Turning a protection on works at once. Turning one off, or making it slower, waits for the person.
        </p>
      }
      onSave={async () => {
        const r = await phoneApi.change("safety", s);
        await reload();
        return r;
      }}
    >
      <label className="ph-check ph-card">
        <input type="checkbox" checked={s.watch} onChange={(e) => setS({ ...s, watch: e.target.checked })} />
        <span>
          <b>Watch over me</b>
          <span className="ph-sub">Alert people if the AGENCY screen goes silent</span>
        </span>
      </label>
      <Choice
        label="Check-ins (the person answers with one look)"
        value={s.checkin_interval_min}
        options={[
          [0, "Off"],
          [30, "Every 30 minutes"],
          [60, "Every hour"],
          [120, "Every 2 hours"],
          [240, "Every 4 hours"],
        ]}
        onChange={(v) => setS({ ...s, checkin_interval_min: v })}
      />
      <label className="ph-check ph-card">
        <input
          type="checkbox"
          checked={s.alert_on_signal_unavailable}
          onChange={(e) => setS({ ...s, alert_on_signal_unavailable: e.target.checked })}
        />
        <span>
          <b>Alert if the camera can&apos;t see their eyes for a few minutes</b>
        </span>
      </label>
      <Choice
        label="How long each person has to answer an alert"
        value={s.ack_timeout_s}
        options={[
          [30, "30 seconds"],
          [45, "45 seconds"],
          [60, "1 minute"],
          [90, "1½ minutes"],
          [120, "2 minutes"],
        ]}
        onChange={(v) => setS({ ...s, ack_timeout_s: v })}
      />
      <Choice
        label="Alert after the screen is silent for"
        value={s.watchdog_timeout_s}
        options={[
          [30, "30 seconds"],
          [60, "1 minute"],
          [120, "2 minutes"],
          [300, "5 minutes"],
        ]}
        onChange={(v) => setS({ ...s, watchdog_timeout_s: v })}
      />
    </Section>
  );
}

// -- things the Mac keeps ------------------------------------------------------------------------------

function PhrasesSection({ setup, reload }: SectionProps) {
  const [list, setList] = useState<string[]>(setup.mac.phrases);
  const [draft, setDraft] = useState("");
  const add = () => {
    const p = draft.trim();
    if (p && !list.includes(p)) setList([...list, p]);
    setDraft("");
  };
  return (
    <Section
      title="Talk phrases"
      intro={<p>Ready-made things to say, on a Talk board called &ldquo;From your carers&rdquo;.</p>}
      onSave={async () => {
        const r = await phoneApi.change("phrases", { phrases: list });
        await reload();
        return r;
      }}
    >
      <ul className="ph-list ph-editable">
        {list.map((p) => (
          <li key={p}>
            <span>{p}</span>
            <button type="button" className="ph-mini" onClick={() => setList(list.filter((x) => x !== p))}>
              Remove
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="ph-muted">No phrases yet.</li>}
      </ul>
      <label className="ph-field">
        <span>New phrase</span>
        <input
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Please turn me onto my side"
        />
      </label>
      <button type="button" className="ph-btn ph-quiet" onClick={add} disabled={!draft.trim()}>
        + Add phrase
      </button>
    </Section>
  );
}

function SitesSection({ setup, reload }: SectionProps) {
  const [list, setList] = useState(setup.mac.favourites);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const add = () => {
    if (!url.trim()) return;
    const name =
      title.trim() ||
      url
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
    setList([...list, { title: name, url: url.trim() }]);
    setTitle("");
    setUrl("");
  };
  return (
    <Section
      title="Favourite sites"
      intro={<p>The big tiles on AGENCY Browser&apos;s start page.</p>}
      onSave={async () => {
        const r = await phoneApi.change("favourites", { favourites: list });
        await reload();
        return r;
      }}
    >
      <ul className="ph-list ph-editable">
        {list.map((f, i) => (
          <li key={`${f.url}-${i}`}>
            <span>
              {f.title}
              <span className="ph-sub">{f.url}</span>
            </span>
            <button type="button" className="ph-mini" onClick={() => setList(list.filter((_, j) => j !== i))}>
              Remove
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="ph-muted">No sites yet.</li>}
      </ul>
      <label className="ph-field">
        <span>Web address</span>
        <input
          inputMode="url"
          autoCapitalize="off"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="bbc.co.uk"
        />
      </label>
      <label className="ph-field">
        <span>Name on the tile (optional)</span>
        <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="BBC" />
      </label>
      <button type="button" className="ph-btn ph-quiet" onClick={add} disabled={!url.trim()}>
        + Add site
      </button>
    </Section>
  );
}

const DETAIL_FIELDS: { key: keyof Details; label: string; type?: string; autoComplete: string }[] = [
  { key: "fullName", label: "Full name", autoComplete: "off" },
  { key: "preferredName", label: "Preferred name", autoComplete: "off" },
  { key: "dateOfBirth", label: "Date of birth (as forms should show it)", autoComplete: "off" },
  { key: "phone", label: "Phone", type: "tel", autoComplete: "off" },
  { key: "email", label: "Email", type: "email", autoComplete: "off" },
  { key: "line1", label: "Street address", autoComplete: "off" },
  { key: "line2", label: "Apartment, unit (optional)", autoComplete: "off" },
  { key: "city", label: "City", autoComplete: "off" },
  { key: "region", label: "State", autoComplete: "off" },
  { key: "postalCode", label: "ZIP code", autoComplete: "off" },
];
const EMPTY_DETAILS: Details = {
  fullName: "",
  preferredName: "",
  dateOfBirth: "",
  phone: "",
  email: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
};

function DetailsSection({ setup, reload }: SectionProps) {
  const [d, setD] = useState<Details>({ ...EMPTY_DETAILS, ...(setup.mac.details ?? {}) });
  return (
    <Section
      title="Details for forms"
      intro={
        <p>
          Papers offers these when a form asks; the person checks each one. Never add passwords, card or ID
          numbers. The person&apos;s own details, not yours.
        </p>
      }
      onSave={async () => {
        const r = await phoneApi.change("details", { details: d });
        await reload();
        return r;
      }}
    >
      {DETAIL_FIELDS.map((f) => (
        <label key={f.key} className="ph-field">
          <span>{f.label}</span>
          <input
            type={f.type ?? "text"}
            autoComplete={f.autoComplete}
            maxLength={200}
            value={d[f.key]}
            onChange={(e) => setD({ ...d, [f.key]: e.target.value })}
          />
        </label>
      ))}
    </Section>
  );
}

function PapersSection({ setup, reload }: SectionProps) {
  const [folder, setFolder] = useState<"papers" | "downloads">("papers");
  return (
    <Section
      title="Papers folder"
      intro={
        <p>
          The one folder Papers may open letters and forms from, and save signed copies to. Now:{" "}
          <b>{setup.mac.papers_folder?.display ?? "none chosen"}</b>. To pick any other folder, use the Mac.
        </p>
      }
      onSave={async () => {
        const r = await phoneApi.change("papers_folder", { folder });
        await reload();
        return r;
      }}
    >
      <label className="ph-check ph-card">
        <input
          type="radio"
          name="folder"
          checked={folder === "papers"}
          onChange={() => setFolder("papers")}
        />
        Documents, AGENCY Papers
      </label>
      <label className="ph-check ph-card">
        <input
          type="radio"
          name="folder"
          checked={folder === "downloads"}
          onChange={() => setFolder("downloads")}
        />
        Downloads
      </label>
    </Section>
  );
}
