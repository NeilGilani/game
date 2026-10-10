/** ClinicBook (sandbox): choose a provider, a day and a time, visit type and reason, then book. */

import { esc, notFound, page, redirect, type Req, type Res } from "../http.ts";
import { record, type World } from "../world.ts";

export const PROVIDERS = [
  { id: "ortiz", name: "Dr. Ana Ortiz", specialty: "Primary care", video: true },
  { id: "lee", name: "Dr. Sam Lee", specialty: "Neurology", video: true },
  { id: "kim", name: "Pat Kim, PT", specialty: "Physical therapy", video: false },
];

const TIMES = ["9:00 AM", "9:30 AM", "10:00 AM", "11:00 AM", "1:30 PM", "2:00 PM", "3:30 PM", "4:00 PM"];

/** The next 7 weekdays from `from`, as YYYY-MM-DD. */
export function bookingDays(from = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (out.length < 7) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Deterministic availability: some slots are already taken, so pickers must handle disabled options. */
export function slotTaken(w: World, provider: string, day: string, time: string): boolean {
  if (w.clinic.bookings.some((b) => b.provider === provider && b.day === day && b.time === time)) return true;
  let h = 0;
  for (const ch of provider + day + time) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3 === 0;
}

function label(day: string): string {
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const CSS = `:root{--brand:#2b8a3e} .days{display:flex;gap:8px;flex-wrap:wrap} .days a{padding:10px 14px;border-radius:8px;border:1px solid #bbb;text-decoration:none}
.days a[aria-current]{background:var(--brand);color:#fff} .slots{display:flex;gap:8px;flex-wrap:wrap}`;

function layout(title: string, body: string): Res {
  return page({
    title: `${title} · ClinicBook`,
    brand: "ClinicBook",
    css: CSS,
    nav: [
      ["/", "Book a visit"],
      ["/visits", "My visits"],
    ],
    body,
  });
}

export function clinic(w: World, r: Req): Res {
  if (r.method === "GET" && r.path === "/") {
    return layout(
      "Choose a provider",
      `<h1>Who would you like to see?</h1><div class="grid">${PROVIDERS.map(
        (p) =>
          `<div class="card"><h2>${esc(p.name)}</h2><p>${esc(p.specialty)}${p.video ? " · Video visits available" : ""}</p><a class="btn primary" href="/p/${p.id}">See times for ${esc(p.name)}</a></div>`,
      ).join("")}</div>`,
    );
  }
  const pm = /^\/p\/(\w+)$/.exec(r.path);
  if (pm && r.method === "GET") {
    const p = PROVIDERS.find((x) => x.id === pm[1]);
    if (!p) return notFound();
    const days = bookingDays();
    const day = days.includes(r.query.get("day") ?? "") ? (r.query.get("day") as string) : days[0]!;
    const err = r.query.get("error");
    return layout(
      p.name,
      `<h1>Book with ${esc(p.name)}</h1><p>${esc(p.specialty)}</p>${err ? `<p class="error" role="alert">${esc(err)}</p>` : ""}
<h2>Choose a day</h2><nav class="days" aria-label="Days">${days.map((d) => `<a href="/p/${p.id}?day=${d}" ${d === day ? `aria-current="date"` : ""}>${label(d)}</a>`).join("")}</nav>
<form method="post" action="/book" class="card"><input type="hidden" name="provider" value="${p.id}"><input type="hidden" name="day" value="${day}">
<fieldset><legend>Times on ${label(day)}</legend><div class="slots">${TIMES.map((t, i) => {
        const taken = slotTaken(w, p.id, day, t);
        return `<span><input type="radio" id="t${i}" name="time" value="${t}" ${taken ? "disabled" : ""}><label for="t${i}" style="display:inline">${t}${taken ? " (taken)" : ""}</label></span>`;
      }).join("")}</div></fieldset>
<fieldset class="inline"><legend>Visit type</legend><input type="radio" id="vt-in" name="visitType" value="In person" checked><label for="vt-in">In person</label>
${p.video ? `<input type="radio" id="vt-video" name="visitType" value="Video"><label for="vt-video">Video</label>` : ""}</fieldset>
<label for="reason">Reason for visit</label><textarea id="reason" name="reason" rows="3"></textarea>
<p><button type="submit" class="primary">Book appointment</button></p></form>`,
    );
  }
  if (r.method === "POST" && r.path === "/book") {
    const p = PROVIDERS.find((x) => x.id === r.form.get("provider"));
    const day = r.form.get("day") ?? "";
    const time = r.form.get("time") ?? "";
    if (!p) return notFound();
    const back = (e: string) =>
      redirect(`/p/${p.id}?day=${encodeURIComponent(day)}&error=${encodeURIComponent(e)}`);
    if (!bookingDays().includes(day)) return back("Choose a day.");
    if (!TIMES.includes(time)) return back("Choose a time.");
    if (slotTaken(w, p.id, day, time)) return back("That time was just taken. Choose another.");
    if (!(r.form.get("reason") ?? "").trim()) return back("Tell the clinic the reason for your visit.");
    const visitType = r.form.get("visitType") === "Video" && p.video ? "Video" : "In person";
    const b = {
      id: `CB-${700 + w.clinic.bookings.length + 1}`,
      provider: p.id,
      providerName: p.name,
      day,
      time,
      visitType,
      reason: (r.form.get("reason") ?? "").slice(0, 300),
    };
    w.clinic.bookings.push(b);
    record(w, "clinic", "appointment.booked", b);
    return layout(
      "Booked",
      `<div class="card" role="status"><h1>You're booked</h1><p>${esc(p.name)}, ${label(day)} at ${time} (${visitType}). Confirmation ${b.id}.</p></div>`,
    );
  }
  if (r.method === "GET" && r.path === "/visits") {
    return layout(
      "My visits",
      `<h1>My visits</h1>${w.clinic.bookings.length ? `<ul>${w.clinic.bookings.map((b) => `<li>${esc(b.providerName)}: ${label(b.day ?? "")} at ${esc(b.time)}</li>`).join("")}</ul>` : "<p>No visits booked.</p>"}`,
    );
  }
  return notFound();
}
