/**
 * Limits the person or caregiver sets. Enforced by the guard in code, not by the prompt.
 */

export interface SafetySettings {
  /** Largest single purchase the agent may even ask approval for, in dollars. null = no purchases at all. */
  maxPurchase: number | null;
  /** Total purchases approved in a rolling 24 hours, in dollars. */
  maxPurchasePerDay: number | null;
  /**
   * Web origins the agent may act on (click, type, navigate to). Reading the current page is always allowed.
   * Entries are origins ("https://shop.example") or host suffixes ("*.example.org").
   */
  siteAllowlist: string[];
  /** When true (the default), consequential actions only run against simulated targets. */
  simulatedOnly: boolean;
  /**
   * Ordering for real on the person's own DoorDash, Uber Eats, Amazon or Instacart in Chrome (Settings, off by
   * default). Only the ordering pack reads this; it never widens what the model or any other pack may do.
   */
  realOrdering?: RealOrdering;
}

export interface RealOrdering {
  enabled: boolean;
  /** Largest order total, in dollars, the ordering pack may even ask approval for. */
  maxOrder: number;
}

/** Off, with a $60 cap ready for when a caregiver turns it on. */
export const DEFAULT_REAL_ORDERING: RealOrdering = { enabled: false, maxOrder: 60 };

/** The real-ordering setting from a settings file, checked: anything odd means off. */
export function realOrderingOf(s: SafetySettings): RealOrdering {
  const r = s.realOrdering as Partial<RealOrdering> | undefined;
  const max = typeof r?.maxOrder === "number" && Number.isFinite(r.maxOrder) ? r.maxOrder : NaN;
  if (!r || r.enabled !== true || !(max > 0) || max > 1000)
    return { enabled: false, maxOrder: max > 0 && max <= 1000 ? max : DEFAULT_REAL_ORDERING.maxOrder };
  return { enabled: true, maxOrder: max };
}

export const DEFAULT_SETTINGS: SafetySettings = {
  maxPurchase: 50,
  maxPurchasePerDay: 100,
  siteAllowlist: ["http://localhost:*", "http://127.0.0.1:*", "*.sandbox.agency.test"],
  simulatedOnly: true,
};

export function originAllowed(origin: string, allowlist: string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return allowlist.some((entry) => matchEntry(url, entry));
}

function matchEntry(url: URL, entry: string): boolean {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(2).toLowerCase();
    return url.hostname === suffix || url.hostname.endsWith("." + suffix);
  }
  const m = /^(https?):\/\/([^/:]+)(?::(\*|\d+))?\/?$/.exec(entry);
  if (!m) return false;
  const [, proto, host, port] = m;
  if (url.protocol !== `${proto}:` || url.hostname !== host) return false;
  if (port === "*") return true;
  const defaultPort = proto === "https" ? "443" : "80";
  return (url.port || defaultPort) === (port ?? defaultPort);
}

/** All dollar amounts in a text, e.g. "Total: $24.80" -> [24.8]. */
export function dollarAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:US)?\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) {
    out.push(Number(m[1]!.replace(/,/g, "")));
  }
  return out;
}

/** The amount labelled as the total, or the largest amount on the page when none is labelled. */
export function pageTotal(text: string): number | null {
  const labelled =
    /\b(order total|grand total|total due|amount due|total to pay|you pay|total)\b[^$\n]{0,20}(\$\s?[\d,]+(?:\.\d{1,2})?)/i.exec(
      text,
    );
  if (labelled) return dollarAmounts(labelled[2]!)[0] ?? null;
  const all = dollarAmounts(text);
  return all.length ? Math.max(...all) : null;
}
