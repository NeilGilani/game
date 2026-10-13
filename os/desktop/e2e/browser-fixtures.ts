/**
 * Local pages for AGENCY Browser's end-to-end tests (e2e/fixtures/browser), served at
 * http://library.localhost:<port>/. Nothing here is real. /thanks echoes the form, escaped; /download/... is an
 * attachment.
 */

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

const ROOT = join(__dirname, "fixtures", "browser");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Fixtures {
  port: number;
  url(path?: string): string;
  close(): Promise<void>;
}

export async function startFixtures(): Promise<Fixtures> {
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/thanks") {
      const rows = [...u.searchParams].map(
        ([k, v]) => `<li>${escape(k)}: <span class="${escape(k)}">${escape(v)}</span></li>`,
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><title>Thank you</title><h1>Thank you for joining</h1><ul>${rows.join("")}</ul>`,
      );
      return;
    }
    if (u.pathname.startsWith("/download/")) {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="reading-list.txt"',
      });
      res.end("1. The Secret Garden\n2. Anne of Green Gables\n");
      return;
    }
    const path = normalize(join(ROOT, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname)));
    if (!path.startsWith(ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    readFile(path).then(
      (body) => {
        const type = TYPES[extname(path)] ?? "application/octet-stream";
        // Ranges, as real sites serve video: without them a video can't seek.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        if (range && (range[1] || range[2])) {
          const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
          res.writeHead(206, {
            "content-type": type,
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${body.length}`,
            "content-length": String(end - start + 1),
          });
          res.end(body.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, { "content-type": type, "accept-ranges": "bytes" });
        res.end(body);
      },
      () => res.writeHead(404).end("not found"),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (path = "/") => `http://library.localhost:${port}${path}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
