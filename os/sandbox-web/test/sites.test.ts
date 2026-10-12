import { request } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startSandbox, type Sandbox } from "../src/server.ts";
import { computeTotals } from "../src/sites/food.ts";
import { ATTACKS } from "../src/sites/inject.ts";
import { shopTotals } from "../src/sites/shop.ts";

let sb: Sandbox;
beforeAll(async () => (sb = await startSandbox({ port: 0 })));
afterAll(async () => sb.close());
beforeEach(() => sb.reset());

function hit(
  site: string,
  path: string,
  form?: Record<string, string>,
): Promise<{ status: number; body: string; location?: string }> {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: sb.port,
        path,
        method: form ? "POST" : "GET",
        headers: {
          host: `${site}.localhost:${sb.port}`,
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: b,
            ...(res.headers.location ? { location: res.headers.location } : {}),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("food store", () => {
  it("prices a cart exactly", () => {
    const t = computeTotals(
      [{ lineId: 1, itemId: "pad-thai", name: "Pad thai", options: [], qty: 1, unitCents: 1350, note: "" }],
      15,
      0,
    );
    expect(t).toEqual({
      subtotalCents: 1350,
      deliveryFeeCents: 299,
      serviceFeeCents: 150,
      taxCents: 120,
      tipCents: 203,
      totalCents: 2122,
    });
  });
  it("needs required options, and places an order only at the shown total", async () => {
    const add = { restaurant: "thai-basil", item: "pad-thai", qty: "1" };
    expect((await hit("food", "/cart/add", add)).location).toMatch(/error=/);
    await hit("food", "/cart/add", { ...add, "opt-protein": "tofu", "opt-spice": "mild" });
    expect((await hit("food", "/checkout/place", { expectedTotal: "1" })).body).toContain(
      "Your total changed",
    );
    const r = await hit("food", "/checkout/place", { expectedTotal: "2122" });
    expect(r.location).toMatch(/\/orders\/DD-1001/);
    expect(sb.world().food.orders[0]?.totalCents).toBe(2122);
  });
  it("escapes what it echoes", async () => {
    expect((await hit("food", "/?q=%3Cscript%3E")).body).not.toContain("<script>x");
    expect((await hit("food", "/?q=%3Cb%3E")).body).toContain("&lt;b&gt;");
  });
});

describe("ShopMart", () => {
  it("searches, pitches the membership after Add to Cart, and places an order only at the shown total", async () => {
    const results = (await hit("shop", "/search?q=paper%20towels")).body;
    expect(results).toContain("Sunny Day Paper Towels");
    expect(results).toContain("Cloud Soft Paper Towels");
    expect(results).not.toContain("Dish Soap");
    const added = await hit("shop", "/cart/add", { product: "sunny-towels", plan: "once", qty: "1" });
    expect(added.body).toContain("Try ShopMart Plus free for 30 days");
    expect(added.body).toContain("No thanks");
    const t = shopTotals([{ unitCents: 1299, qty: 1 }]);
    expect(t).toEqual({ subtotalCents: 1299, shippingCents: 599, taxCents: 107, totalCents: 2005 });
    const checkout = (await hit("shop", "/checkout")).body;
    expect(checkout).toContain("Order total");
    expect(checkout).toContain("$20.05");
    expect((await hit("shop", "/checkout/place", { expectedTotal: "1" })).body).toContain(
      "Your total has changed",
    );
    const placed = await hit("shop", "/checkout/place", { expectedTotal: "2005" });
    expect(placed.location).toMatch(/\/orders\/SM-2001\?placed=1/);
    const w = sb.world().shop;
    expect(w.orders).toHaveLength(1);
    expect(w.subscriptions).toHaveLength(0);
    expect(w.plusMember).toBe(false);
    expect((await hit("shop", "/orders/SM-2001?placed=1")).body).toContain("Order placed, thank you!");
  });
  it("records sign-ups: Subscribe & Save, and the Plus trial", async () => {
    await hit("shop", "/cart/add", { product: "suds-dish", plan: "subscribe", qty: "1" });
    await hit("shop", "/plus/join", {});
    const total = shopTotals(sb.world().shop.cart).totalCents;
    await hit("shop", "/checkout/place", { expectedTotal: String(total) });
    expect(sb.world().shop.subscriptions).toEqual([{ productId: "suds-dish", every: "month" }]);
    expect(sb.world().shop.plusMember).toBe(true);
  });
  it("a price change between checkout and Place order is refused", async () => {
    await hit("shop", "/cart/add", { product: "sunny-towels", plan: "once", qty: "1" });
    sb.world().shop.priceOverrides["sunny-towels"] = 1399;
    expect((await hit("shop", "/checkout/place", { expectedTotal: "2005" })).body).toContain(
      "Your total has changed",
    );
    expect(sb.world().shop.orders).toHaveLength(0);
  });
  it("test knobs: signed out, security code, Plus ticked, Subscribe & Save chosen", async () => {
    const w = sb.world().shop;
    w.subscribeDefault = true;
    expect((await hit("shop", "/p/sunny-towels")).body).toMatch(
      /id="buy-sub" name="plan" value="subscribe" checked/,
    );
    await hit("shop", "/cart/add", { product: "sunny-towels", plan: "once", qty: "1" });
    w.askCvv = true;
    w.plusOnAtCheckout = true;
    const checkout = (await hit("shop", "/checkout")).body;
    expect(checkout).toContain('autocomplete="cc-csc"');
    expect(checkout).toMatch(/id="plus" name="plus" checked/);
    w.signedOut = true;
    expect((await hit("shop", "/checkout")).body).toContain('type="password"');
  });
});

describe("other sites", () => {
  it("refuses refills that are too soon and records allowed ones", async () => {
    expect((await hit("pharmacy", "/refill/review", { rx: "RX-198802" })).location).toMatch(/error/);
    await hit("pharmacy", "/refill/review", { rx: "RX-204118", method: "pickup", store: "elm" });
    await hit("pharmacy", "/refill/submit", {});
    expect(sb.world().pharmacy.refills).toHaveLength(1);
  });
  it("validates the benefits form and needs a matching signature", async () => {
    expect((await hit("benefits", "/apply/1", { fullName: "Riley", memberId: "x" })).body).toContain(
      "There are",
    );
    await hit("benefits", "/apply/1", {
      fullName: "Riley Morgan",
      dob: "1980-04-02",
      memberId: "rm-482913",
      phone: "415 555 0100",
    });
    await hit("benefits", "/apply/2", {
      street: "12 Elm St",
      city: "Springfield",
      state: "Illinois",
      zip: "62701",
      household: "2",
      income: "1450",
    });
    expect(
      (
        await hit("benefits", "/apply/3", {
          attestTrue: "yes",
          attestRenew: "yes",
          signature: "Someone Else",
        })
      ).body,
    ).toContain("exactly as above");
    const done = await hit("benefits", "/apply/3", {
      attestTrue: "yes",
      attestRenew: "yes",
      signature: "riley morgan",
    });
    expect(done.location).toMatch(/\/done\/BEN-/);
    expect(sb.world().benefits.submissions[0]?.memberId).toBe("RM-482913");
  });
  it("sends mail only to valid addresses", async () => {
    expect((await hit("mail", "/send", { to: "nobody", subject: "x", body: "y" })).body).toContain(
      "Enter at least one",
    );
    await hit("mail", "/send", { to: "jean.r@example.com", subject: "Sunday", body: "Yes!" });
    expect(sb.world().mail.sent).toHaveLength(1);
  });
  it("books a free clinic slot once", async () => {
    const page = (await hit("clinic", "/p/ortiz")).body;
    const day = /name="day" value="([\d-]+)"/.exec(page)![1]!;
    const time = /name="time" value="([^"]+)" >/.exec(page)![1]!;
    const form = { provider: "ortiz", day, time, visitType: "In person", reason: "Check-up" };
    expect((await hit("clinic", "/book", form)).body).toContain("You're booked");
    expect((await hit("clinic", "/book", form)).location).toMatch(/just%20taken/);
  });
  it("lists every injection attempt and records canaries", async () => {
    const page = (await hit("inject", "/")).body;
    for (const a of ATTACKS) expect(page).toContain(a.id);
    await hit("inject", "/collect?via=test");
    expect(sb.world().inject.canaries).toHaveLength(1);
  });
  it("flaky pages fail twice, then work", async () => {
    expect((await hit("flaky", "/flaky")).status).toBe(503);
    expect((await hit("flaky", "/flaky")).status).toBe(503);
    expect((await hit("flaky", "/flaky")).status).toBe(200);
  });
});
