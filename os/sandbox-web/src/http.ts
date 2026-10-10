/** Tiny request/response helpers and HTML building for the sandbox sites (no dependencies). */

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  json: unknown;
  /** The site's own origin, e.g. http://food.localhost:8787 */
  origin: string;
  /** The port the sandbox runs on, for links between sites. */
  port: number;
}

export type Res =
  | { kind: "html"; status?: number; body: string; headers?: Record<string, string> }
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "redirect"; to: string; status?: number }
  | { kind: "text"; status?: number; body: string }
  /** Never answers (until the client gives up or the server closes). */
  | { kind: "hang" }
  | { kind: "delay"; ms: number; then: Res };

export const html = (body: string, status = 200): Res => ({ kind: "html", status, body });
export const json = (body: unknown, status = 200): Res => ({ kind: "json", status, body });
export const redirect = (to: string): Res => ({ kind: "redirect", to, status: 303 });
export const notFound = (): Res => ({ kind: "text", status: 404, body: "Not found" });

/** Escapes text for HTML. Every value from a request goes through this. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const c = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(c / 100).toLocaleString("en-US")}.${String(c % 100).padStart(2, "0")}`;
}

export function siteUrl(r: Req, site: string, path = "/"): string {
  return `http://${site}.localhost:${r.port}${path}`;
}

export interface PageOptions {
  title: string;
  /** Brand shown in the header. */
  brand: string;
  css: string;
  body: string;
  nav?: Array<[string, string]>;
  script?: string;
  /** Hide the sandbox ribbon (only the injection page uses this to look like a normal blog). */
  ribbon?: boolean;
}

const BASE_CSS = `
*{box-sizing:border-box} body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d1d1f;background:#f6f6f7}
a{color:inherit} header.site{display:flex;align-items:center;gap:24px;padding:12px 24px;background:var(--brand);color:#fff}
header.site .brand{font-weight:800;font-size:22px;text-decoration:none} header.site nav{display:flex;gap:16px;flex-wrap:wrap}
header.site nav a{color:#fff;text-decoration:none;opacity:.95} header.site nav a:hover{text-decoration:underline}
main{max-width:1040px;margin:0 auto;padding:24px} .card{background:#fff;border-radius:12px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin:12px 0}
button,.btn{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer;text-decoration:none;display:inline-block;color:#1d1d1f}
button.primary,.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:700}
button:disabled{opacity:.5;cursor:not-allowed} label{display:block;font-weight:600;margin:10px 0 4px}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=date],input[type=password],select,textarea{font:inherit;padding:8px;border:1px solid #aaa;border-radius:6px;width:100%;max-width:420px;background:#fff}
.inline label{display:inline;font-weight:400;margin:0 12px 0 4px} .muted{color:#666} .error{color:#b00020;font-weight:600}
.ribbon{background:#fff3cd;color:#664d03;text-align:center;font-size:13px;padding:4px}
table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e5e5}
.row{display:flex;gap:16px;flex-wrap:wrap} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.total{font-size:20px;font-weight:800}`;

export function page(o: PageOptions): Res {
  const nav = (o.nav ?? []).map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join("");
  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title><style>${BASE_CSS}${o.css}</style></head>
<body>${o.ribbon === false ? "" : `<div class="ribbon" role="note">Sandbox site for testing AGENCY. Nothing here is real: no money moves and no one is contacted.</div>`}
<header class="site"><a class="brand" href="/">${esc(o.brand)}</a><nav aria-label="Main">${nav}</nav></header>
<main>${o.body}</main>${o.script ? `<script>${o.script}</script>` : ""}</body></html>`);
}
