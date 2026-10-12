/**
 * A small, conservative ad and tracker block list, written for AGENCY (not copied from any published filter list).
 * Only whole hosts that serve ads or tracking and nothing a page needs to work, and only when a page loads them
 * from another site: a site's own scripts and the page itself are never blocked. Off in Settings for a helper.
 *
 * Fewer ads means fewer moving things under the person's gaze and fewer pop-ups to dismiss, not a promise of no ads.
 */

export const AD_HOSTS: readonly string[] = [
  // Ad serving and exchanges
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
  "adnxs.com",
  "adsrvr.org",
  "advertising.com",
  "amazon-adsystem.com",
  "criteo.com",
  "criteo.net",
  "outbrain.com",
  "taboola.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "indexww.com",
  "smartadserver.com",
  "media.net",
  "yieldmo.com",
  "sharethrough.com",
  "teads.tv",
  "33across.com",
  "bidswitch.net",
  "adform.net",
  "moatads.com",
  "zedo.com",
  "revcontent.com",
  "mgid.com",
  "popads.net",
  "propellerads.com",
  "adcolony.com",
  "serving-sys.com",
  "contextweb.com",
  // Tracking and analytics beacons
  "scorecardresearch.com",
  "quantserve.com",
  "quantcount.com",
  "hotjar.com",
  "mouseflow.com",
  "crazyegg.com",
  "fullstory.com",
  "clarity.ms",
  "bat.bing.com",
  "ads.linkedin.com",
  "analytics.tiktok.com",
  "ads-twitter.com",
  "pixel.facebook.com",
  "krxd.net",
  "bluekai.com",
  "demdex.net",
  "everesttech.net",
  "rlcdn.com",
  "agkn.com",
  "exelator.com",
  "tapad.com",
  "adsymptotic.com",
  "chartbeat.net",
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The registrable-ish part of a host (last two labels, or three for "co.uk"-style names). Enough to tell sites apart. */
export function siteOf(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  if (/^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(last2)) return parts.slice(-3).join(".");
  return last2;
}

/**
 * Block this request? Only third-party requests to a listed host; never the page itself (`resourceType`
 * "mainFrame"), so following a link to one of these sites still works.
 */
export function isBlockedAd(url: string, pageUrl: string | null, resourceType: string): boolean {
  if (resourceType === "mainFrame") return false;
  const host = hostOf(url);
  if (!host) return false;
  const listed = AD_HOSTS.find((d) => matches(host, d));
  if (!listed) return false;
  const page = pageUrl ? hostOf(pageUrl) : null;
  if (page && (matches(page, listed) || siteOf(page) === siteOf(host))) return false;
  return true;
}
