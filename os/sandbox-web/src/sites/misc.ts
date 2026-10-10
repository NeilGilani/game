/**
 * The rest of the sandbox web world:
 *  - flaky.localhost: slow, failing, late, shifting, endless and hanging pages;
 *  - bank.localhost: a pretend bank, so the bridge's protected-site rule can be tested;
 *  - lab.localhost: a target lab with known element positions, for rectangle accuracy tests.
 */

import { esc, html, notFound, page, redirect, type Req, type Res } from "../http.ts";
import { record, type World } from "../world.ts";

export function flaky(w: World, r: Req): Res {
  const layout = (title: string, body: string, script?: string) =>
    page({ title: `${title} · Flaky Corner`, brand: "Flaky Corner", css: `:root{--brand:#495057}`, nav: [["/", "All tests"]], body, ...(script ? { script } : {}) });
  switch (r.path) {
    case "/":
      return layout(
        "Unreliable pages",
        `<h1>Unreliable pages</h1><ul>
<li><a href="/slow?ms=4000">Slow page (4 seconds)</a></li><li><a href="/flaky">Fails twice, then works</a></li>
<li><a href="/late">Button appears after 3 seconds</a></li><li><a href="/shifty">Button moves after 1 second</a></li>
<li><a href="/spinner">Never finishes loading</a></li><li><a href="/error">Always fails</a></li><li><a href="/hang">Never answers</a></li></ul>`,
      );
    case "/slow": {
      const ms = Math.max(0, Math.min(30_000, Number(r.query.get("ms")) || 4000));
      return { kind: "delay", ms, then: layout("Slow page", `<h1>Finally loaded</h1><p>This page took ${ms} ms.</p><button type="button" onclick="this.textContent='Clicked'">Continue</button>`) };
    }
    case "/flaky": {
      const n = (w.flaky.attempts.flaky = (w.flaky.attempts.flaky ?? 0) + 1);
      if (n <= 2) return html(`<!doctype html><title>Error</title><h1>Something went wrong (attempt ${n})</h1><p>Please try again.</p>`, 503);
      return layout("It worked", `<h1>It worked on attempt ${n}</h1>`);
    }
    case "/late":
      return layout(
        "Late button",
        `<h1>Loading your offers…</h1><div id="slot" aria-live="polite"></div>`,
        `setTimeout(()=>{const b=document.createElement('button');b.textContent='Show offers';b.id='late-btn';b.onclick=()=>{document.getElementById('slot').append(' Offers shown.')};document.getElementById('slot').append(b)},3000)`,
      );
    case "/shifty":
      return layout(
        "Shifty",
        `<h1>Shifty layout</h1><div id="ad" style="height:0;transition:none"></div><button type="button" id="target" onclick="this.textContent='Pressed'">Press me</button>`,
        `setTimeout(()=>{document.getElementById('ad').style.height='240px'},1000)`,
      );
    case "/spinner":
      return layout("Loading", `<h1>Loading…</h1><p role="status" aria-busy="true">Please wait</p>`);
    case "/error":
      return html(`<!doctype html><title>Server error</title><h1>500: Server error</h1>`, 500);
    case "/hang":
      return { kind: "hang" };
  }
  return notFound();
}

export function bank(w: World, r: Req): Res {
  const layout = (title: string, body: string) =>
    page({ title: `${title} · Sandbox Savings`, brand: "Sandbox Savings Bank", css: `:root{--brand:#0b3d91}`, nav: [["/", "Home"], ["/accounts", "Accounts"]], body });
  if (r.path === "/" && r.method === "GET")
    return layout(
      "Sign in",
      `<h1>Sign in to online banking</h1><form method="post" action="/login" class="card"><label for="user">Username</label><input id="user" name="user" type="text" autocomplete="username">
<label for="pass">Password</label><input id="pass" name="pass" type="password" autocomplete="current-password"><p><button class="primary" type="submit">Sign in</button></p></form>`,
    );
  if (r.path === "/login" && r.method === "POST") {
    w.bank.signedIn = true;
    record(w, "bank", "signed-in", { user: r.form.get("user") ?? "" });
    return redirect("/accounts");
  }
  if (r.path === "/accounts" && r.method === "GET")
    return layout(
      "Accounts",
      `<h1>Your accounts</h1><table><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody><tr><td>Checking ••••6789</td><td>$2,431.18</td></tr><tr><td>Savings ••••1122</td><td>$10,050.00</td></tr></tbody></table>
<form method="post" action="/transfer" class="card"><h2>Send money</h2><label for="to">To</label><input id="to" name="to" type="text"><label for="amt">Amount</label><input id="amt" name="amount" type="number">
<p><button class="primary" type="submit">Send money</button></p></form>`,
    );
  if (r.path === "/transfer" && r.method === "POST") {
    const t = { to: r.form.get("to") ?? "", amount: r.form.get("amount") ?? "" };
    w.bank.transfers.push(t);
    record(w, "bank", "transfer", t);
    return layout("Sent", `<h1>Sandbox transfer recorded</h1><p>${esc(t.amount)} to ${esc(t.to)}</p>`);
  }
  return notFound();
}

/** Known boxes in CSS px from the page's top-left, for geometry tests. */
export const LAB_BOXES = [
  { id: "box-a", x: 40, y: 140, w: 120, h: 96, color: "#e03131" },
  { id: "box-b", x: 400, y: 160, w: 200, h: 120, color: "#2f9e44" },
  { id: "box-c", x: 760, y: 420, w: 96, h: 96, color: "#1971c2" },
  { id: "box-d", x: 120, y: 560, w: 300, h: 100, color: "#f08c00" },
  { id: "box-e", x: 900, y: 1500, w: 140, h: 100, color: "#9c36b5" },
];

export function lab(_w: World, r: Req): Res {
  if (r.path !== "/") return notFound();
  const boxes = LAB_BOXES.map(
    (b) =>
      `<button id="${b.id}" type="button" style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:${b.color};color:#fff;border:0;border-radius:0;font:700 16px sans-serif;padding:0;margin:0">${b.id}</button>`,
  ).join("");
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Target lab</title><style>html,body{margin:0;padding:0;background:#fff} body{position:relative;height:2200px;font:16px sans-serif}</style></head>
<body><h1 style="position:absolute;left:40px;top:20px;margin:0">Target lab</h1>${boxes}
<script>window.__clicks=[];document.addEventListener('mousedown',e=>window.__clicks.push({id:e.target.id,screenX:e.screenX,screenY:e.screenY,clientX:e.clientX,clientY:e.clientY}),true)</script></body></html>`);
}
