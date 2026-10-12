/**
 * The address and search box: is what the person typed a web address or something to search for, and what to
 * suggest while they type. Pure, so it is unit-tested; main checks every address again before a page opens.
 */

export type SearchEngine = "google" | "duckduckgo" | "bing";

export type OmniboxResult =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string; query: string }
  | { kind: "blocked"; reason: string }
  | { kind: "empty" };

const ENGINES: Record<SearchEngine, { name: string; url: (q: string) => string }> = {
  google: { name: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  duckduckgo: { name: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  bing: { name: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
};

export function engineName(engine: SearchEngine): string {
  return ENGINES[engine].name;
}

export function searchUrl(query: string, engine: SearchEngine): string {
  return ENGINES[engine].url(query.trim());
}

const BLOCKED: Record<string, string> = {
  "file:": "Files on this computer can't be opened in AGENCY Browser.",
  "javascript:": "That runs code instead of opening a page.",
  "data:": "That has no web address.",
  "blob:": "That has no web address.",
  "chrome:": "Browser settings pages are off limits.",
  "chrome-extension:": "Browser extension pages are off limits.",
  "devtools:": "Developer tools are off limits.",
  "view-source:": "Page source is off limits.",
  "agency:": "That is part of AGENCY itself.",
  "about:": "That isn't a web page.",
  "mailto:": "Email links open another app, which AGENCY Browser doesn't do. A helper can.",
  "tel:": "Phone links open another app, which AGENCY Browser doesn't do. Use Call someone on Home.",
  "sms:": "Text links open another app, which AGENCY Browser doesn't do. Use Messages on Home.",
};

/** Top-level names people type without "https://": "bbc.co.uk", "example.com", "news.ycombinator.com". */
const HOSTLIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\.?(?::\d{1,5})?(?:[/?#].*)?$/i;
const LOCAL = /^(?:localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#].*)?$/;

/**
 * Typed text to what to open. A full http(s) address opens as is. Something that looks like a site name ("bbc.com",
 * "www.example.org/news") opens on https. This computer (localhost) opens on http. Anything else is a search.
 * Other schemes (file:, javascript:...) are refused with a plain reason.
 */
export function parseOmnibox(input: string, engine: SearchEngine = "google"): OmniboxResult {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && BLOCKED[scheme]) return { kind: "blocked", reason: BLOCKED[scheme]! };
  if (scheme === "http:" || scheme === "https:") {
    try {
      const u = new URL(text);
      if (u.username || u.password)
        return {
          kind: "blocked",
          reason: "That address hides a user name or password in it, a common trick.",
        };
      return { kind: "url", url: u.href };
    } catch {
      return { kind: "search", url: searchUrl(text, engine), query: text };
    }
  }
  if (!/\s/.test(text)) {
    if (LOCAL.test(text)) return { kind: "url", url: new URL(`http://${text}`).href };
    if (HOSTLIKE.test(text) || IPV4.test(text)) {
      try {
        const u = new URL(`https://${text}`);
        return { kind: "url", url: u.href };
      } catch {
        // falls through to search
      }
    }
  }
  return { kind: "search", url: searchUrl(text, engine), query: text };
}

export interface Suggestion {
  kind: "open" | "search" | "ask" | "history" | "favourite";
  label: string;
  /** The address to open; for "ask", the goal for AGENCY. */
  value: string;
  sub?: string;
}

/** "www.example.com/news" from an address, for showing. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * What to offer under the box: the typed text as an address or a search, asking AGENCY to do it, and matching
 * favourites and history (newest first). At most `limit`, no repeats.
 */
export function suggestions(
  input: string,
  opts: {
    engine: SearchEngine;
    history: readonly { url: string; title: string }[];
    favourites: readonly { url: string; title: string }[];
    limit?: number;
    askAgency?: boolean;
  },
): Suggestion[] {
  const text = input.trim();
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (s: Suggestion) => {
    const key = `${s.kind === "ask" ? "ask" : "go"}:${s.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  if (text) {
    const parsed = parseOmnibox(text, opts.engine);
    if (parsed.kind === "url")
      push({ kind: "open", label: `Go to ${displayUrl(parsed.url)}`, value: parsed.url });
    if (parsed.kind === "search" || parsed.kind === "url")
      push({
        kind: "search",
        label: `Search ${engineName(opts.engine)} for “${text}”`,
        value: searchUrl(text, opts.engine),
      });
    if (opts.askAgency !== false) push({ kind: "ask", label: `Ask AGENCY: ${text}`, value: text });
  }
  const needle = text.toLowerCase();
  const matches = (e: { url: string; title: string }) =>
    !needle || e.title.toLowerCase().includes(needle) || displayUrl(e.url).toLowerCase().includes(needle);
  for (const f of opts.favourites)
    if (matches(f)) push({ kind: "favourite", label: f.title, value: f.url, sub: displayUrl(f.url) });
  for (const h of opts.history)
    if (matches(h))
      push({ kind: "history", label: h.title || displayUrl(h.url), value: h.url, sub: displayUrl(h.url) });
  return out.slice(0, opts.limit ?? 6);
}
