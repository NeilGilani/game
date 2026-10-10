/**
 * Benefits portal (sandbox): a three-step application with server-side validation, an error summary,
 * attestations and a typed signature, ending in a reference number.
 */

import { esc, notFound, page, redirect, type Req, type Res } from "../http.ts";
import { record, type World } from "../world.ts";

interface Field {
  name: string;
  label: string;
  type: "text" | "date" | "email" | "tel" | "number" | "select" | "checkbox";
  step: 1 | 2 | 3;
  hint?: string;
  options?: string[];
  autocomplete?: string;
  validate: (v: string, all: Record<string, string>) => string | null;
}

const STATES = ["", "California", "Illinois", "Massachusetts", "New York", "Texas", "Washington"];
const required = (label: string) => (v: string) => (v.trim() ? null : `Enter ${label}.`);

export const FIELDS: Field[] = [
  { name: "fullName", label: "Full legal name", type: "text", step: 1, autocomplete: "name", validate: (v) => (v.trim().split(/\s+/).length >= 2 ? null : "Enter your first and last name.") },
  {
    name: "dob",
    label: "Date of birth",
    type: "date",
    step: 1,
    autocomplete: "bday",
    validate: (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "Enter your date of birth.";
      const y = Number(v.slice(0, 4));
      return y < 1900 || new Date(v) > new Date() ? "Enter a real date of birth." : null;
    },
  },
  { name: "memberId", label: "Member ID", type: "text", step: 1, hint: "Two letters, a dash, then six numbers, like AB-123456. It's on your benefits letter.", validate: (v) => (/^[A-Z]{2}-\d{6}$/.test(v.trim().toUpperCase()) ? null : "Enter your member ID like AB-123456.") },
  { name: "phone", label: "Phone number", type: "tel", step: 1, autocomplete: "tel", validate: (v) => (v.replace(/\D/g, "").length === 10 ? null : "Enter a 10-digit phone number.") },
  { name: "email", label: "Email (optional)", type: "email", step: 1, autocomplete: "email", validate: (v) => (!v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "Enter an email like name@example.com, or leave it empty.") },
  { name: "street", label: "Street address", type: "text", step: 2, autocomplete: "street-address", validate: required("your street address") },
  { name: "city", label: "City", type: "text", step: 2, autocomplete: "address-level2", validate: required("your city") },
  { name: "state", label: "State", type: "select", step: 2, options: STATES, validate: (v) => (STATES.includes(v) && v ? null : "Choose your state.") },
  { name: "zip", label: "ZIP code", type: "text", step: 2, autocomplete: "postal-code", validate: (v) => (/^\d{5}$/.test(v.trim()) ? null : "Enter a 5-digit ZIP code.") },
  { name: "household", label: "People in your household", type: "number", step: 2, validate: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 12 ? null : "Enter a number from 1 to 12.") },
  { name: "income", label: "Household income per month ($)", type: "number", step: 2, validate: (v) => (/^\d+(\.\d{1,2})?$/.test(v) && +v >= 0 && +v < 100000 ? null : "Enter monthly income in dollars, for example 1450.") },
  { name: "attestTrue", label: "I confirm this information is true to the best of my knowledge.", type: "checkbox", step: 3, validate: (v) => (v === "yes" ? null : "Confirm that the information is true.") },
  { name: "attestRenew", label: "I understand I must report changes within 10 days.", type: "checkbox", step: 3, validate: (v) => (v === "yes" ? null : "Confirm that you will report changes.") },
  {
    name: "signature",
    label: "Type your full legal name to sign",
    type: "text",
    step: 3,
    validate: (v, all) => (v.trim().toLowerCase() === (all.fullName ?? "").trim().toLowerCase() && v.trim() ? null : "Type your full legal name exactly as above to sign."),
  },
];

const CSS = `:root{--brand:#1c3d5a} .err-summary{border:3px solid #b00020;padding:12px 16px;border-radius:8px;background:#fff5f5}
.field-error{color:#b00020;font-weight:600;display:block} .hint{color:#555;display:block;font-size:14px} .stepper{list-style:none;display:flex;gap:16px;padding:0}
.stepper li[aria-current]{font-weight:800;text-decoration:underline}`;

const STEP_TITLES = ["About you", "Your household", "Review and sign"];

function layout(title: string, body: string): Res {
  return page({ title: `${title} · Benefits Portal`, brand: "State Benefits Portal", css: CSS, nav: [["/", "Home"], ["/apply/1", "Apply or renew"]], body });
}

function fieldHtml(f: Field, value: string, error: string | null): string {
  const id = `f-${f.name}`;
  const describedBy = [f.hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ");
  const aria = `${error ? ` aria-invalid="true"` : ""}${describedBy ? ` aria-describedby="${describedBy}"` : ""}`;
  const hint = f.hint ? `<span class="hint" id="${id}-hint">${esc(f.hint)}</span>` : "";
  const err = error ? `<span class="field-error" id="${id}-err">${esc(error)}</span>` : "";
  if (f.type === "checkbox")
    return `<div><input type="checkbox" id="${id}" name="${f.name}" value="yes" ${value === "yes" ? "checked" : ""}${aria}> <label for="${id}" style="display:inline">${esc(f.label)}</label>${err}</div>`;
  if (f.type === "select")
    return `<label for="${id}">${esc(f.label)}</label>${hint}${err}<select id="${id}" name="${f.name}"${aria}>${(f.options ?? []).map((o) => `<option value="${esc(o)}" ${o === value ? "selected" : ""}>${o ? esc(o) : "Choose…"}</option>`).join("")}</select>`;
  return `<label for="${id}">${esc(f.label)}</label>${hint}${err}<input id="${id}" name="${f.name}" type="${f.type}" value="${esc(value)}"${f.autocomplete ? ` autocomplete="${f.autocomplete}"` : ""}${aria}>`;
}

export function benefits(w: World, r: Req): Res {
  const b = w.benefits;
  if (r.method === "GET" && r.path === "/") {
    return layout(
      "Home",
      `<h1>Apply for or renew your benefits</h1><p>It takes about 10 minutes. You'll need your member ID from your letter.</p><p><a class="btn primary" href="/apply/1">Start your application</a></p>
<p class="muted">Renewals are due by November 1.</p>`,
    );
  }
  const m = /^\/apply\/([123])$/.exec(r.path);
  if (m) {
    const step = Number(m[1]) as 1 | 2 | 3;
    const fields = FIELDS.filter((f) => f.step === step);
    let errors: Array<[Field, string]> = [];
    if (r.method === "POST") {
      for (const f of fields) b.draft[f.name] = f.type === "checkbox" ? (r.form.get(f.name) ?? "") : (r.form.get(f.name) ?? "").slice(0, 200);
      errors = fields.map((f) => [f, f.validate(b.draft[f.name] ?? "", b.draft)] as [Field, string | null]).filter((x): x is [Field, string] => !!x[1]);
      if (!errors.length) {
        if (step < 3) return redirect(`/apply/${step + 1}`);
        const earlier = FIELDS.filter((f) => f.step < 3 && f.validate(b.draft[f.name] ?? "", b.draft));
        if (earlier.length) return redirect(`/apply/${earlier[0]!.step}`);
        const reference = `BEN-${(2026_0000 + b.submissions.length + 1).toString()}`;
        const sub = { ...b.draft, memberId: (b.draft.memberId ?? "").toUpperCase(), reference };
        b.submissions.push(sub);
        b.draft = {};
        record(w, "benefits", "application.submitted", { reference });
        return redirect(`/done/${reference}`);
      }
    }
    const errMap = new Map(errors.map(([f, e]) => [f.name, e]));
    const review =
      step === 3
        ? `<div class="card"><h2>Check your answers</h2><dl>${FIELDS.filter((f) => f.step < 3)
            .map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(b.draft[f.name] || "(empty)")}</dd>`)
            .join("")}</dl><p><a href="/apply/1">Change your details</a></p></div>`
        : "";
    return layout(
      STEP_TITLES[step - 1] ?? "",
      `<ol class="stepper">${STEP_TITLES.map((t, i) => `<li ${i + 1 === step ? `aria-current="step"` : ""}>${i + 1}. ${t}</li>`).join("")}</ol>
<h1>${STEP_TITLES[step - 1]}</h1>${
        errors.length
          ? `<div class="err-summary" role="alert" tabindex="-1"><h2>There ${errors.length === 1 ? "is a problem" : `are ${errors.length} problems`}</h2><ul>${errors
              .map(([f, e]) => `<li><a href="#f-${f.name}">${esc(e)}</a></li>`)
              .join("")}</ul></div>`
          : ""
      }${review}<form method="post" action="/apply/${step}" class="card" novalidate>${fields.map((f) => fieldHtml(f, b.draft[f.name] ?? "", errMap.get(f.name) ?? null)).join("")}
<p>${step > 1 ? `<a class="btn" href="/apply/${step - 1}">Back</a> ` : ""}<button type="submit" class="primary">${step === 3 ? "Sign and submit application" : "Save and continue"}</button></p></form>`,
    );
  }
  const d = /^\/done\/(BEN-\d+)$/.exec(r.path);
  if (d && r.method === "GET") {
    return layout("Submitted", `<div class="card" role="status"><h1>Application submitted</h1><p>Your reference number is <strong>${esc(d[1])}</strong>. Keep it for your records.</p></div>`);
  }
  return notFound();
}
