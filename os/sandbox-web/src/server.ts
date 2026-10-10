/**
 * The sandbox web world's server. Each site has its own origin, http://<site>.localhost:<port>/ (Chrome
 * resolves every *.localhost name to this computer), so origin-based rules like the protected-site list
 * behave as they would on the real web. It listens on 127.0.0.1 only.
 *
 * Test API, on any host:
 *   GET  /__test/state             everything that happened (orders, refills, submissions, mail, canaries)
 *   POST /__test/reset             start over
 *   POST /__test/food/advance      move every order's tracking one step forward
 *   POST /__test/food/price        { item, cents } change a menu price (to test approvals going stale)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { esc, page, type Req, type Res } from "./http.ts";
import { benefits } from "./sites/benefits.ts";
import { clinic } from "./sites/clinic.ts";
import { food } from "./sites/food.ts";
import { inject } from "./sites/inject.ts";
import { mail } from "./sites/mail.ts";
import { bank, flaky, lab } from "./sites/misc.ts";
import { pharmacy } from "./sites/pharmacy.ts";
import { newWorld, type World } from "./world.ts";

export const SITES: Record<
  string,
  { title: string; about: string; handler: (w: World, r: Req) => Res | Promise<Res> }
> = {
  food: {
    title: "DashDish",
    about: "Food delivery: menus, options, cart, fees, tip, checkout, tracking.",
    handler: food,
  },
  pharmacy: { title: "CareRx", about: "Prescription refills.", handler: pharmacy },
  benefits: {
    title: "State Benefits Portal",
    about: "A benefits application with validation.",
    handler: benefits,
  },
  mail: { title: "Postbox", about: "Webmail: read, reply, compose, send, delete.", handler: mail },
  clinic: { title: "ClinicBook", about: "Appointment booking.", handler: clinic },
  inject: {
    title: "Simmer & Spoon",
    about: "A recipe blog full of prompt-injection attempts.",
    handler: inject,
  },
  flaky: { title: "Flaky Corner", about: "Slow, failing and unreliable pages.", handler: flaky },
  bank: { title: "Sandbox Savings", about: "A pretend bank (a protected site).", handler: bank },
  lab: { title: "Target lab", about: "Known element positions for geometry tests.", handler: lab },
};

export interface Sandbox {
  port: number;
  /** http://<site>.localhost:<port><path> */
  url: (site: string, path?: string) => string;
  world: () => World;
  reset: () => void;
  close: () => Promise<void>;
}

export interface SandboxOptions {
  port?: number;
  host?: string;
}

const MAX_BODY = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  let world = newWorld();
  const hanging = new Set<ServerResponse>();
  let port = 0;

  const send = async (res: ServerResponse, out: Res): Promise<void> => {
    switch (out.kind) {
      case "html":
        res.writeHead(out.status ?? 200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...(out.headers ?? {}),
        });
        res.end(out.body);
        return;
      case "json":
        res.writeHead(out.status ?? 200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(out.body, null, 2));
        return;
      case "text":
        res.writeHead(out.status ?? 200, { "content-type": "text/plain; charset=utf-8" });
        res.end(out.body);
        return;
      case "redirect":
        res.writeHead(out.status ?? 303, { location: out.to });
        res.end();
        return;
      case "hang":
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
        return;
      case "delay":
        await new Promise((r) => setTimeout(r, out.ms));
        if (!res.destroyed) await send(res, out.then);
        return;
    }
  };

  const testApi = (method: string, path: string, body: unknown): Res | null => {
    if (path === "/__test/state" && method === "GET") return { kind: "json", body: world };
    if (path === "/__test/reset" && method === "POST") {
      world = newWorld();
      return { kind: "json", body: { ok: true } };
    }
    if (path === "/__test/food/advance" && method === "POST") {
      for (const o of world.food.orders) o.advancedSteps++;
      return { kind: "json", body: { ok: true } };
    }
    if (path === "/__test/food/price" && method === "POST") {
      const b = body as { item?: string; cents?: number } | null;
      if (!b?.item || typeof b.cents !== "number")
        return { kind: "json", status: 400, body: { error: "item and cents required" } };
      world.food.priceOverrides[b.item] = b.cents;
      return { kind: "json", body: { ok: true } };
    }
    return null;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const host = (req.headers.host ?? "localhost").toLowerCase();
        const url = new URL(req.url ?? "/", `http://${host}`);
        const raw = req.method === "POST" ? await readBody(req) : "";
        const ctype = req.headers["content-type"] ?? "";
        const isJson = ctype.includes("application/json");
        let jsonBody: unknown = null;
        if (isJson && raw) {
          try {
            jsonBody = JSON.parse(raw);
          } catch {
            jsonBody = null;
          }
        }
        if (url.pathname.startsWith("/__test/")) {
          const out = testApi(req.method ?? "GET", url.pathname, jsonBody);
          await send(res, out ?? { kind: "json", status: 404, body: { error: "unknown test endpoint" } });
          return;
        }
        const sub = url.hostname.endsWith(".localhost") ? url.hostname.slice(0, -".localhost".length) : "";
        const site = SITES[sub];
        if (!site) {
          await send(
            res,
            page({
              title: "Sandbox web world",
              brand: "AGENCY sandbox",
              css: ":root{--brand:#14213d}",
              body: `<h1>Sandbox web world</h1><p>Pretend websites for testing AGENCY. Nothing here is real.</p><ul>${Object.entries(
                SITES,
              )
                .map(
                  ([k, s]) =>
                    `<li><a href="http://${k}.localhost:${port}/">${esc(s.title)}</a>: ${esc(s.about)}</li>`,
                )
                .join("")}</ul>`,
            }),
          );
          return;
        }
        const r: Req = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          form: isJson ? new URLSearchParams() : new URLSearchParams(raw),
          json: jsonBody,
          origin: `http://${host}`,
          port,
        };
        await send(res, await site.handler(world, r));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end(`Sandbox error: ${(e as Error).message}`);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    url: (site, path = "/") => `http://${site}.localhost:${port}${path}`,
    world: () => world,
    reset: () => {
      world = newWorld();
    },
    close: async () => {
      for (const r of hanging) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
