/**
 * Settings, For a helper, Order for real: lets Food and Shopping order on the person's own DoorDash or Uber Eats,
 * and Amazon or Instacart, in Chrome (Mac app only), with a spending cap. Off by default. See state/realOrdering.ts.
 */
import { useEffect, useState } from "react";
import { ConfirmSheet } from "../components/common";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { useAnnounce } from "../state/announcer";
import {
  CAP_RANGE,
  hostRealOrdering,
  loadRealOrdering,
  realOrderingAvailable,
  rememberRealOrdering,
  saveRealOrdering,
  SITE_NAMES,
  type FoodSite,
  type RealOrdering,
  type ShopSite,
} from "../state/realOrdering";
import { navigate } from "../state/router";
import { Stepper, Toggle } from "./SettingsViews";

const FOOD_SITES: FoodSite[] = ["doordash", "ubereats"];
const SHOP_SITES: ShopSite[] = ["amazon", "instacart"];

export function OrderingSettings() {
  const announce = useAnnounce();
  const available = realOrderingAvailable();
  const [prefs, setPrefs] = useState<RealOrdering>(loadRealOrdering);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The Mac app's own copy is the one the agent follows: show that.
  useEffect(() => {
    let live = true;
    void hostRealOrdering().then((h) => {
      if (!live || !h) return;
      setPrefs((p) => {
        const next = { ...p, enabled: h.enabled && p.enabled, maxOrder: h.maxOrder };
        rememberRealOrdering(next);
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, []);

  const apply = async (next: RealOrdering) => {
    setBusy(true);
    const r = await saveRealOrdering(next);
    setBusy(false);
    setPrefs(r.ok ? next : { ...next, enabled: false });
    const text = r.ok
      ? next.enabled
        ? `Ordering for real is on. Each order is at most $${next.maxOrder.toFixed(2)}, and you approve every total.`
        : "Ordering for real is off. Food and Shopping are practice."
      : (r.error ?? "That didn't save.");
    setNote(text);
    announce(text);
  };

  const change = (patch: Partial<RealOrdering>) => void apply({ ...prefs, ...patch });

  return (
    <Page label="Order for real">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings · For a helper</div>
          <h1>Order for real</h1>
          <p>
            When this is on, Food and Shopping order for real on your own {SITE_NAMES[prefs.food]} and{" "}
            {SITE_NAMES[prefs.shopping]} in Chrome. AGENCY finds what you chose, fills the cart and stops at
            checkout. It shows the exact total, delivery address and card, and pays only after you approve.
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/settings/helper")} data-dwell>
          <Icon name="back" /> For a helper
        </button>
      </div>

      {!available ? (
        <p className="panel" role="note">
          Ordering for real works only in the AGENCY Mac app. Here, Food and Shopping are practice: nothing is
          bought.
        </p>
      ) : (
        <>
          <section className="panel stack" aria-labelledby="ord-before">
            <h2 id="ord-before">
              <Icon name="list" /> Before turning it on, a helper should
            </h2>
            <ol className="stack">
              <li>Install the AGENCY extension in Chrome and pair it with this Mac.</li>
              <li>
                Sign in to {SITE_NAMES[prefs.food]} and {SITE_NAMES[prefs.shopping]} in Chrome.
              </li>
              <li>Save a delivery address and a card on each site.</li>
            </ol>
            <p className="small muted">
              AGENCY never types passwords, card numbers or codes, never changes an address or a card, and
              never signs up for memberships or repeat deliveries. If a site asks for any of that, it stops
              and asks for a helper.
            </p>
          </section>

          <div className="grid grid-2">
            <Toggle
              label="Order for real with your own DoorDash / Amazon in Chrome"
              value={prefs.enabled}
              onChange={(on) => (on ? setConfirming(true) : change({ enabled: false }))}
              help={prefs.enabled ? "You approve every total" : "Food and Shopping are practice"}
            />
            <Stepper
              label="Most one order may cost"
              value={prefs.maxOrder}
              display={`$${prefs.maxOrder.toFixed(0)}`}
              min={CAP_RANGE.min}
              max={CAP_RANGE.max}
              step={CAP_RANGE.step}
              onChange={(v) => change({ maxOrder: v })}
              help="Anything over this is refused before you are even asked."
            />
          </div>

          <section className="stack" aria-labelledby="ord-sites">
            <h2 id="ord-sites">
              <Icon name="globe" /> Which sites
            </h2>
            <div className="grid grid-4" role="group" aria-labelledby="ord-sites">
              {[...FOOD_SITES, ...SHOP_SITES].map((site) => {
                const food = (FOOD_SITES as string[]).includes(site);
                const chosen = food ? prefs.food === site : prefs.shopping === site;
                return (
                  <button
                    key={site}
                    className="tile"
                    style={{ minHeight: 110 }}
                    aria-pressed={chosen}
                    onClick={() => change(food ? { food: site as FoodSite } : { shopping: site as ShopSite })}
                    data-dwell
                  >
                    <span className="tile-title">{SITE_NAMES[site]}</span>
                    <span className="tile-sub">{food ? "For Food" : "For Shopping"}</span>
                    <span className="tile-check">
                      <Icon name="check" size={22} />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {note && (
            <p className="panel" role="status">
              {note}
            </p>
          )}
        </>
      )}

      {confirming && (
        <ConfirmSheet
          title="Turn on ordering for real?"
          confirmLabel="Turn it on"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void apply({ ...prefs, enabled: true });
          }}
        >
          <p>
            Real money will be spent on {SITE_NAMES[prefs.food]} and {SITE_NAMES[prefs.shopping]}, each time
            after you approve the exact total. Each order is at most ${prefs.maxOrder.toFixed(0)}.
          </p>
        </ConfirmSheet>
      )}
    </Page>
  );
}
