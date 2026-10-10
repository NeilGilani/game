/** CareRx (sandbox): prescription refills with eligibility rules, pickup or delivery, review and submit. */

import { esc, notFound, page, redirect, type Req, type Res } from "../http.ts";
import { record, type World } from "../world.ts";

export interface Prescription {
  rx: string;
  name: string;
  dose: string;
  refillsLeft: number;
  lastFilled: string;
  /** Null when it can be refilled now. */
  blocked: null | "too-soon" | "no-refills";
  eligibleOn?: string;
  doctor: string;
}

export const PRESCRIPTIONS: Prescription[] = [
  {
    rx: "RX-204118",
    name: "Riluzole",
    dose: "50 mg tablet, twice a day",
    refillsLeft: 3,
    lastFilled: "Sep 12",
    blocked: null,
    doctor: "Dr. Sam Lee",
  },
  {
    rx: "RX-204377",
    name: "Baclofen",
    dose: "10 mg tablet, three times a day",
    refillsLeft: 2,
    lastFilled: "Sep 20",
    blocked: null,
    doctor: "Dr. Sam Lee",
  },
  {
    rx: "RX-198802",
    name: "Glycopyrrolate",
    dose: "1 mg tablet, as needed",
    refillsLeft: 1,
    lastFilled: "Oct 3",
    blocked: "too-soon",
    eligibleOn: "Oct 24",
    doctor: "Dr. Ana Ortiz",
  },
  {
    rx: "RX-187455",
    name: "Vitamin D3",
    dose: "2000 IU capsule, daily",
    refillsLeft: 0,
    lastFilled: "Aug 30",
    blocked: "no-refills",
    doctor: "Dr. Ana Ortiz",
  },
];

export const STORES = [
  { id: "elm", label: "CareRx Elm Street (open until 9 pm)" },
  { id: "main", label: "CareRx Main Street (open 24 hours)" },
];

const CSS = `:root{--brand:#0b7285}`;

function layout(title: string, body: string): Res {
  return page({
    title: `${title} · CareRx`,
    brand: "CareRx Pharmacy",
    css: CSS,
    nav: [
      ["/", "Prescriptions"],
      ["/history", "Refill history"],
    ],
    body,
  });
}

function status(p: Prescription): string {
  if (p.blocked === "too-soon") return `Too soon to refill (you can refill on ${p.eligibleOn})`;
  if (p.blocked === "no-refills") return "No refills left. Ask your doctor for a new prescription.";
  return "Ready to refill";
}

export function pharmacy(w: World, r: Req): Res {
  const ph = w.pharmacy;
  if (r.method === "GET" && r.path === "/") {
    const err = r.query.get("error");
    return layout(
      "Prescriptions",
      `<h1>Hi Riley, here are your prescriptions</h1>${err ? `<p class="error" role="alert">${esc(err)}</p>` : ""}
<form method="post" action="/refill/review" class="card"><table><caption>Your prescriptions</caption>
<thead><tr><th>Refill</th><th>Medicine</th><th>Rx number</th><th>Refills left</th><th>Last filled</th><th>Status</th></tr></thead><tbody>
${PRESCRIPTIONS.map(
  (
    p,
  ) => `<tr><td>${p.blocked ? "" : `<input type="checkbox" id="rx-${p.rx}" name="rx" value="${p.rx}" aria-label="Refill ${esc(p.name)}">`}</td>
<td><label for="rx-${p.rx}"><strong>${esc(p.name)}</strong></label><div class="muted">${esc(p.dose)}</div></td><td>${p.rx}</td><td>${p.refillsLeft}</td><td>${p.lastFilled}</td>
<td>${esc(status(p))}${p.blocked === "no-refills" ? `<br><button type="submit" formaction="/doctor-request" name="doctorRx" value="${p.rx}">Ask ${esc(p.doctor)} for a refill</button>` : ""}</td></tr>`,
).join("")}</tbody></table>
<fieldset class="inline"><legend>How do you want to get it?</legend>
<input type="radio" id="m-pickup" name="method" value="pickup" ${ph.method === "pickup" ? "checked" : ""}><label for="m-pickup">Pick up</label>
<input type="radio" id="m-delivery" name="method" value="delivery" ${ph.method === "delivery" ? "checked" : ""}><label for="m-delivery">Deliver to 12 Elm Street, Apt 3 (free)</label></fieldset>
<label for="store">Pickup store</label><select id="store" name="store">${STORES.map((s) => `<option value="${s.id}" ${ph.store === s.id ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
<p><button type="submit" class="primary">Review refill request</button></p></form>`,
    );
  }

  if (r.method === "POST" && r.path === "/doctor-request") {
    const p = PRESCRIPTIONS.find((x) => x.rx === r.form.get("doctorRx"));
    if (!p) return notFound();
    ph.doctorRequests.push({ rx: p.rx, name: p.name, doctor: p.doctor, at: new Date().toISOString() });
    record(w, "pharmacy", "doctor.requested", { rx: p.rx });
    return layout(
      "Request sent",
      `<h1>Request sent to ${esc(p.doctor)}</h1><p role="status">We asked for a new prescription for ${esc(p.name)}. We'll message you when it's ready.</p><p><a href="/">Back to prescriptions</a></p>`,
    );
  }

  if (r.method === "POST" && r.path === "/refill/review") {
    const rxs = r.form.getAll("rx");
    if (!rxs.length)
      return redirect(`/?error=${encodeURIComponent("Choose at least one prescription to refill.")}`);
    const chosen = rxs.map((x) => PRESCRIPTIONS.find((p) => p.rx === x));
    if (chosen.some((p) => !p || p.blocked))
      return redirect(`/?error=${encodeURIComponent("One of those can't be refilled yet.")}`);
    ph.pending = rxs;
    ph.method = r.form.get("method") === "delivery" ? "delivery" : "pickup";
    ph.store = STORES.some((s) => s.id === r.form.get("store")) ? (r.form.get("store") ?? "elm") : "elm";
    const where =
      ph.method === "delivery"
        ? "Delivery to 12 Elm Street, Apt 3"
        : `Pick up at ${STORES.find((s) => s.id === ph.store)?.label}`;
    return layout(
      "Review refill",
      `<h1>Review your refill request</h1><form method="post" action="/refill/submit" class="card"><ul>${chosen
        .map((p) => `<li><strong>${esc(p!.name)}</strong> ${esc(p!.dose)} (${p!.rx})</li>`)
        .join("")}</ul><p>${esc(where)}</p><p>Estimated copay: $0.00 (insurance on file)</p>
<p><button class="primary" type="submit">Submit refill request</button> <a class="btn" href="/">Change</a></p></form>`,
    );
  }

  if (r.method === "POST" && r.path === "/refill/submit") {
    if (!ph.pending) return redirect("/");
    const id = `RF-${5000 + ph.refills.length + 1}`;
    const entry = {
      id,
      rx: ph.pending,
      method: ph.method,
      store: ph.store,
      at: new Date().toISOString(),
      readyBy: "tomorrow after 2 pm",
    };
    ph.refills.push(entry);
    ph.pending = null;
    record(w, "pharmacy", "refill.submitted", entry);
    return layout(
      "Refill requested",
      `<div class="card" role="status"><h1>Refill requested</h1><p>Confirmation <strong>${id}</strong>. Ready ${entry.readyBy}.</p></div><p><a href="/history">See refill history</a></p>`,
    );
  }

  if (r.method === "GET" && r.path === "/history") {
    return layout(
      "Refill history",
      `<h1>Refill history</h1>${ph.refills.length ? `<ul>${ph.refills.map((x) => `<li>${esc(x.id)}: ${esc((x.rx as string[]).join(", "))} (${esc(x.method)})</li>`).join("")}</ul>` : "<p>No refills requested yet.</p>"}`,
    );
  }
  return notFound();
}
