/**
 * An example task pack (the real ones belong to Instance 8 in os/tasks/). Used to test that packs run without
 * an API key and go through the same guard and approvals.
 */

import type { GuardOutcome } from "../src/guard";
import { ToolError } from "../src/tools/guarded";
import type { TaskPack } from "../src/types";
import { SITES } from "./world/sandboxWeb";

function must(o: GuardOutcome<string>): string {
  if (o.status === "done") return o.value;
  if (o.status === "declined") throw new Declined(o.reason);
  throw new Declined(o.status === "change" ? `You wanted a change: ${o.change}` : o.reason);
}

class Declined extends Error {}

export const thaiBasilUsualPack: TaskPack = {
  id: "food.thai-basil.usual",
  title: "Order your usual from Thai Basil",
  matches: (r) => /usual/i.test(r.goal) && (r.selections?.restaurant ?? "") === "Thai Basil",
  steps: () => [
    {
      id: "s1",
      title: "Open Thai Basil",
      risk: "read",
      async run({ tools }) {
        must(await tools.navigate(`${SITES.STORE}/menu`));
        const page = await tools.readPage();
        return { verified: /Thai Basil/.test(page.title), summary: "Thai Basil is open", evidence: page.url };
      },
    },
    {
      id: "s2",
      title: "Put your usual in the cart",
      risk: "reversible",
      async run({ tools, values, ask }) {
        let dish = values.dish;
        if (!dish) {
          const a = await ask({ prompt: "What would you like?", options: [{ id: "o1", label: "Pad thai" }, { id: "o2", label: "Green curry" }] });
          dish = a.optionId === "o2" ? "Green curry" : "Pad thai";
          values.dish = dish;
        }
        let page = await tools.readPage();
        const add = tools.findByName(page, new RegExp(`^Add ${dish}`, "i"), "button");
        if (!add) throw new ToolError(`${dish} is not on the menu today.`);
        must(await tools.click(add.ref));
        const cart = tools.findByName(page, /^View cart/, "link");
        if (!cart) throw new ToolError("The cart link is missing.");
        must(await tools.click(cart.ref));
        page = await tools.readPage();
        return { verified: page.text.includes(dish), summary: `${dish} is in the cart`, evidence: page.text.split("\n").find((l) => /total/i.test(l)) };
      },
    },
    {
      id: "s3",
      title: "Pay with your saved card",
      risk: "consequential",
      async run({ tools }) {
        const page = await tools.readPage();
        const place = tools.findByName(page, "Place order", "button");
        if (!place) throw new ToolError("There is no Place order button.");
        try {
          must(await tools.click(place.ref, { kind: "purchase", summary: "Place the order and pay with the saved card." }));
        } catch (e) {
          if (e instanceof Declined) return { verified: false, summary: `Declined: ${e.message}` };
          throw e;
        }
        const after = await tools.readPage();
        return { verified: /confirmed/i.test(after.text), summary: "Order placed (simulated)", evidence: after.text.split("\n")[0] };
      },
    },
  ],
};
