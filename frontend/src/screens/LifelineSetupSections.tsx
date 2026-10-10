/**
 * Lifeline setup sections for the rescue: alerting everyone for critical problems, the care plan,
 * emergency services (simulated in this build) and the home. Done with a helper using a keyboard;
 * nothing changes until Save on the setup screen.
 */

import type { DispatchAddress, LifelineSettings, LifelineStatus, PlanKey } from "../api/types";
import { Icon } from "../components/Icon";
import { Stepper, Toggle } from "./SettingsViews";

type Update = (changes: Partial<LifelineSettings>) => void;

export const PLAN_KEYS: { key: PlanKey; label: string }[] = [
  { key: "general", label: "First steps (any alert)" },
  { key: "breathing", label: "Breathing or mask" },
  { key: "choking", label: "Choking or secretions" },
  { key: "equipment", label: "Ventilator or equipment" },
  { key: "pain", label: "Pain" },
  { key: "position", label: "Position or discomfort" },
  { key: "other", label: "Something else" },
];

export const MAX_PLAN_STEPS = 8;
const PHONE = /^\+[1-9]\d{6,14}$/;
const STATE = /^[A-Z]{2}$/;
const ZIP = /^\d{5}(-\d{4})?$/;

/** Problems with the care plan text, keyed by plan. Mirrors the coordinator's validation. */
export function planProblems(plans: LifelineSettings["plans"]): Partial<Record<PlanKey, string>> {
  const out: Partial<Record<PlanKey, string>> = {};
  for (const { key, label } of PLAN_KEYS) {
    const steps = plans[key] ?? [];
    if (steps.length > MAX_PLAN_STEPS) out[key] = `${label}: at most ${MAX_PLAN_STEPS} steps.`;
    else if (steps.some((s) => s.trim().length < 2 || s.trim().length > 200))
      out[key] = `${label}: each step needs 2 to 200 characters.`;
  }
  return out;
}

/** Problems with the emergency-services details. Only checked when permission is given. */
export function dispatchProblems(d: LifelineSettings["dispatch"]): string[] {
  const out: string[] = [];
  if (d.phone && !PHONE.test(d.phone.replace(/\s/g, "")))
    out.push("The phone number must be in international format, like +14155550123.");
  if (d.address.state && !STATE.test(d.address.state)) out.push("State must be a two-letter code, like CA.");
  if (d.pin && !/^\d{4}$/.test(d.pin)) out.push("The PIN must be exactly 4 digits.");
  if (d.consent) {
    if (!d.address.line1 || !d.address.city || !STATE.test(d.address.state) || !ZIP.test(d.address.zip))
      out.push("Emergency services need a full address: street, city, state and ZIP code.");
    if (!d.phone) out.push("Add a phone number the dispatcher can call.");
  }
  return out;
}

/** Text of a plan in the editor: one step per line. Blank lines are dropped when saving. */
export function planFromText(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function CriticalSection({ draft, update }: { draft: LifelineSettings; update: Update }) {
  return (
    <section className="panel stack" aria-labelledby="h-critical">
      <h2 id="h-critical">
        <Icon name="alert" /> When it&apos;s critical, alert everyone at once
      </h2>
      <p>
        Breathing, choking and ventilator problems can become life-threatening within minutes. With this on,
        telling AGENCY one of these (or a ventilator power cut) skips the order above and alerts every contact
        together, instead of one level at a time.
      </p>
      <div className="grid grid-2">
        <Toggle
          label="Alert everyone at once"
          value={draft.critical_alert_everyone}
          onChange={(v) => update({ critical_alert_everyone: v })}
          help={draft.critical_alert_everyone ? "for critical problems" : "always follow the order"}
        />
      </div>
    </section>
  );
}

export function CarePlanSection({
  draft,
  update,
  texts,
  setText,
}: {
  draft: LifelineSettings;
  update: Update;
  /** Raw editor text per plan, so typing a blank line doesn't jump the cursor. */
  texts: Partial<Record<PlanKey, string>>;
  setText: (key: PlanKey, text: string) => void;
}) {
  const problems = planProblems(draft.plans);
  return (
    <section className="panel stack" aria-labelledby="h-plan">
      <h2 id="h-plan">
        <Icon name="document" /> Care plan for helpers
      </h2>
      <p>
        The steps a helper sees on their response page, ticked off as they go. Write one step per line, at
        most {MAX_PLAN_STEPS} per situation, in plain words.
      </p>
      <p className="ll-warning" role="note">
        <Icon name="shield" size={20} /> A real care plan is written with the person&apos;s care team. AGENCY
        never makes up medical steps: it only shows what is written here.
      </p>
      <div className="grid grid-2 ll-plan">
        {PLAN_KEYS.map(({ key, label }) => {
          const steps = draft.plans[key] ?? [];
          const id = `plan-${key}`;
          return (
            <label className="field" key={key} htmlFor={id}>
              <span>
                {label}{" "}
                <span className="small muted">
                  · {steps.length} of {MAX_PLAN_STEPS} steps
                </span>
              </span>
              <textarea
                id={id}
                rows={5}
                value={texts[key] ?? steps.join("\n")}
                aria-invalid={!!problems[key]}
                onChange={(e) => {
                  setText(key, e.target.value);
                  const next = { ...draft.plans };
                  const parsed = planFromText(e.target.value);
                  if (parsed.length) next[key] = parsed;
                  else delete next[key];
                  update({ plans: next });
                }}
              />
              {problems[key] && (
                <span className="ll-field-error" role="alert">
                  {problems[key]}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <label className="field">
        <span>
          Note shown with the plan <span className="small muted">· e.g. who wrote it and when</span>
        </span>
        <input
          value={draft.plans_note}
          maxLength={200}
          onChange={(e) => update({ plans_note: e.target.value })}
        />
      </label>
    </section>
  );
}

const ADDRESS_FIELDS: { key: keyof DispatchAddress; label: string; max: number; hint?: string }[] = [
  { key: "line1", label: "Street address", max: 100 },
  { key: "line2", label: "Apartment, floor", max: 100, hint: "optional" },
  { key: "city", label: "City", max: 60 },
  { key: "state", label: "State", max: 2, hint: "two letters, e.g. CA" },
  { key: "zip", label: "ZIP code", max: 10 },
];

export function DispatchSection({
  draft,
  update,
  status,
}: {
  draft: LifelineSettings;
  update: Update;
  status: LifelineStatus | null;
}) {
  const d = draft.dispatch;
  const set = (changes: Partial<LifelineSettings["dispatch"]>) => update({ dispatch: { ...d, ...changes } });
  const simulated = status?.dispatch.simulated ?? true;
  const provider = status?.dispatch.provider ?? "Demo Emergency Dispatch";
  const problems = dispatchProblems(d);
  return (
    <section className="panel stack" aria-labelledby="h-dispatch">
      <h2 id="h-dispatch">
        <Icon name="phone" /> Emergency services
        {simulated && (
          <span className="badge" data-tone="sim">
            Simulated in this build
          </span>
        )}
      </h2>
      <p>
        This is a separate permission from contacting the people above. If you allow it, AGENCY can ask a
        staffed dispatch centre to send an ambulance: its people check the emergency and contact{" "}
        {draft.emergency_number} with your address. AGENCY never calls {draft.emergency_number} by itself.
      </p>
      {simulated && (
        <p className="ll-warning" role="note">
          <Icon name="shield" size={20} /> {provider} is simulated: no real emergency service is ever
          contacted in this build. Connecting a real one is a decision for you and your care team.
        </p>
      )}
      <label className="ll-consent">
        <input type="checkbox" checked={d.consent} onChange={(e) => set({ consent: e.target.checked })} />
        <span>
          I agree that AGENCY may <strong>request emergency services</strong> for me when I ask for an
          ambulance, when a helper asks for one on my behalf, or when a critical alert goes unanswered for the
          time below. The dispatcher will receive my name, address, phone number, how to get in, and my
          responder card.
        </span>
      </label>
      <p className="small muted">
        {d.consent && d.consented_at ? `Recorded ${new Date(d.consented_at).toLocaleString()}. ` : ""}
        You can withdraw this at any time.
      </p>
      <div className="grid grid-2">
        <Stepper
          label="Ask automatically after"
          value={d.auto_after_s}
          display={d.auto_after_s ? `${d.auto_after_s} s` : "Never"}
          min={0}
          max={600}
          step={15}
          onChange={(v) => set({ auto_after_s: v })}
          help="A critical alert nobody has answered for this long. Never means only you or a helper can ask."
        />
      </div>
      <fieldset className="ll-contact" aria-describedby="dispatch-address-hint">
        <legend>Where to send help</legend>
        <p id="dispatch-address-hint" className="small muted" style={{ gridColumn: "1 / -1" }}>
          Dispatch centres need the address in parts, exactly as it is written on the building.
        </p>
        {ADDRESS_FIELDS.map((f) => (
          <label className="field" key={f.key}>
            <span>
              {f.label}
              {f.hint && <span className="small muted"> · {f.hint}</span>}
            </span>
            <input
              value={d.address[f.key]}
              maxLength={f.max}
              autoComplete="off"
              onChange={(e) =>
                set({
                  address: {
                    ...d.address,
                    [f.key]: f.key === "state" ? e.target.value.toUpperCase() : e.target.value,
                  },
                })
              }
            />
          </label>
        ))}
        <label className="field">
          <span>
            Phone for the dispatcher <span className="small muted">· +14155550123</span>
          </span>
          <input
            value={d.phone}
            inputMode="tel"
            maxLength={20}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <span>
            How responders get in{" "}
            <span className="small muted">· e.g. key safe by the door, who has keys</span>
          </span>
          <input value={d.entry} maxLength={200} onChange={(e) => set({ entry: e.target.value })} />
        </label>
        <label className="field">
          <span>
            Cancel PIN <span className="small muted">· 4 digits, needed to cancel a request</span>
          </span>
          <input
            value={d.pin}
            inputMode="numeric"
            maxLength={4}
            autoComplete="off"
            onChange={(e) => set({ pin: e.target.value.replace(/\D/g, "") })}
          />
        </label>
      </fieldset>
      {problems.map((p) => (
        <p className="ll-field-error" role="alert" key={p}>
          {p}
        </p>
      ))}
    </section>
  );
}

export function HomeSection({
  draft,
  update,
  status,
}: {
  draft: LifelineSettings;
  update: Update;
  status: LifelineStatus | null;
}) {
  const h = draft.home;
  const set = (changes: Partial<LifelineSettings["home"]>) => update({ home: { ...h, ...changes } });
  const home = status?.home;
  return (
    <section className="panel stack" aria-labelledby="h-home">
      <h2 id="h-home">
        <Icon name="home" /> Your home
        {home?.simulated !== false && (
          <span className="badge" data-tone="sim">
            {home?.provider ?? "Demo home"} (simulated)
          </span>
        )}
      </h2>
      <p>
        What AGENCY may do in your home during an alert, if a smart home is connected. In this build the
        lights, door and power are a simulated home: no real lock is ever opened.
      </p>
      <div className="grid grid-3">
        <Toggle
          label="Lights on during an alert"
          value={h.lights_on_alert}
          onChange={(v) => set({ lights_on_alert: v })}
          help="so helpers can see"
        />
        <Toggle
          label="Unlock the door for a helper"
          value={h.unlock_for_responders}
          onChange={(v) => set({ unlock_for_responders: v })}
          help="when they say they're at the door (simulated)"
        />
        <Toggle
          label="Unlock for emergency services"
          value={h.unlock_for_emergency_services}
          onChange={(v) => set({ unlock_for_emergency_services: v })}
          help="when an ambulance is confirmed (simulated)"
        />
        <Stepper
          label="Lock again after"
          value={h.relock_after_min}
          display={`${h.relock_after_min} min`}
          min={5}
          max={120}
          step={5}
          onChange={(v) => set({ relock_after_min: v })}
        />
        <Toggle
          label="Watch the ventilator's power"
          value={h.watch_power}
          onChange={(v) => set({ watch_power: v })}
          help="alert on a power cut"
        />
        <Stepper
          label="Critical below"
          value={h.power_critical_minutes}
          display={`${h.power_critical_minutes} min`}
          min={5}
          max={240}
          step={5}
          onChange={(v) => set({ power_critical_minutes: v })}
          help="of battery left: everyone is alerted at once."
        />
      </div>
      {home && !home.has_power && h.watch_power && (
        <p className="small muted">
          No power reading is connected yet. Connect the ventilator&apos;s outlet or UPS through the home
          system to use this.
        </p>
      )}
    </section>
  );
}
