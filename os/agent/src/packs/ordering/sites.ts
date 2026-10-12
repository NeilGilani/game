/**
 * The ordering sites: the only places the ordering pack may act. Real sites are exact https hostnames on the
 * default port; the two sandbox shops (os/sandbox-web) are http on *.localhost and count as simulated. Anything
 * else, a lookalike host, another port, a login host on a different domain, is not an ordering site.
 */

export type SiteId = "doordash" | "ubereats" | "amazon" | "instacart" | "dashdish" | "shopmart";

export interface OrderSite {
  id: SiteId;
  /** What the person sees: "DoorDash". */
  name: string;
  kind: "food" | "shopping";
  /** Sandbox shops only: nothing real can happen there. */
  simulated: boolean;
  /** The exact hostnames the pack may act on. */
  hosts: readonly string[];
  /** Where the pack starts: the site's own search results for what the person wants. */
  searchUrl(query: string): string;
  /** Food: the path of a restaurant's page, from search results. */
  storePath?: RegExp;
  /** The path of a product or menu-item page. */
  itemPath?: RegExp;
  /** The checkout page. The pack opens it directly instead of pressing a "Checkout" button. */
  checkoutUrl: string;
}

const q = (s: string) => encodeURIComponent(s.trim());

/** The real sites. Their page layouts change without notice; the pack reads them, it doesn't assume. */
export const REAL_SITES: Record<"doordash" | "ubereats" | "amazon" | "instacart", OrderSite> = {
  doordash: {
    id: "doordash",
    name: "DoorDash",
    kind: "food",
    simulated: false,
    hosts: ["www.doordash.com", "doordash.com"],
    searchUrl: (s) => `https://www.doordash.com/search/store/${q(s)}/`,
    storePath: /^\/store\/[^/]+/,
    checkoutUrl: "https://www.doordash.com/consumer/checkout/",
  },
  ubereats: {
    id: "ubereats",
    name: "Uber Eats",
    kind: "food",
    simulated: false,
    hosts: ["www.ubereats.com"],
    searchUrl: (s) => `https://www.ubereats.com/search?q=${q(s)}`,
    storePath: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?store\/[^/]+/,
    checkoutUrl: "https://www.ubereats.com/checkout",
  },
  amazon: {
    id: "amazon",
    name: "Amazon",
    kind: "shopping",
    simulated: false,
    hosts: ["www.amazon.com", "amazon.com", "smile.amazon.com"],
    searchUrl: (s) => `https://www.amazon.com/s?k=${q(s)}`,
    itemPath: /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/,
    checkoutUrl: "https://www.amazon.com/gp/buy/spc/handlers/display.html?hasWorkingJavascript=1",
  },
  instacart: {
    id: "instacart",
    name: "Instacart",
    kind: "shopping",
    simulated: false,
    hosts: ["www.instacart.com"],
    searchUrl: (s) => `https://www.instacart.com/store/s?k=${q(s)}`,
    itemPath: /^\/(?:store\/)?(?:[^/]+\/)?products\/[^/]+/,
    checkoutUrl: "https://www.instacart.com/store/checkout_v3",
  },
};

/** The sandbox shops on this computer (os/sandbox-web), for tests, evals and practice. */
export function sandboxSites(port: number): Record<"dashdish" | "shopmart", OrderSite> {
  const food = `http://food.localhost:${port}`;
  const shop = `http://shop.localhost:${port}`;
  return {
    dashdish: {
      id: "dashdish",
      name: "DashDish (sandbox)",
      kind: "food",
      simulated: true,
      hosts: ["food.localhost"],
      searchUrl: (s) => `${food}/?q=${q(s)}`,
      storePath: /^\/r\/[^/]+$/,
      itemPath: /^\/r\/[^/]+\/item\/[^/]+$/,
      checkoutUrl: `${food}/checkout`,
    },
    shopmart: {
      id: "shopmart",
      name: "ShopMart (sandbox)",
      kind: "shopping",
      simulated: true,
      hosts: ["shop.localhost"],
      searchUrl: (s) => `${shop}/search?q=${q(s)}`,
      itemPath: /^\/p\/[^/]+$/,
      checkoutUrl: `${shop}/checkout`,
    },
  };
}

export function siteFor(id: string | undefined, sandboxPort: number): OrderSite | null {
  if (!id) return null;
  const all: Record<string, OrderSite> = { ...REAL_SITES, ...sandboxSites(sandboxPort) };
  return Object.prototype.hasOwnProperty.call(all, id) ? all[id]! : null;
}

/**
 * May the pack act on this address for this site? Real sites: https, no other port, no user name or password in
 * the address, hostname exactly one of the site's. Sandbox shops: http on their own *.localhost name and the
 * sandbox's port. The URL parser lowercases hosts and turns international names into punycode, so lookalikes fail.
 */
export function onSite(site: OrderSite, address: string, sandboxPort: number): boolean {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (!site.hosts.includes(u.hostname)) return false;
  if (site.simulated) return u.protocol === "http:" && u.port === String(sandboxPort);
  return u.protocol === "https:" && u.port === "";
}

/** The origins the guard may act on for this site (its allow-list entries). */
export function siteOrigins(site: OrderSite, sandboxPort: number): string[] {
  return site.hosts.map((h) => (site.simulated ? `http://${h}:${sandboxPort}` : `https://${h}`));
}
