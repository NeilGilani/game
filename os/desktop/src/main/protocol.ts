/**
 * The agency:// protocol. Every AGENCY window loads from it:
 *   agency://shell/...    the interface (frontend/dist); /api and /respond are proxied to the coordinator with
 *                         the token added here, so the renderer never sees it and Pi mode needs no CORS
 *   agency://overlay/...  os/overlay/dist, or the built-in fallback overlay
 *   agency://gaze/...     os/gaze/dist
 *   agency://host/...     built-in pages (onboarding, gaze placeholder)
 * Each response carries a strict Content-Security-Policy.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { CoordinatorClient } from "./coordinator";

export const SCHEME = "agency";
export type Host = "shell" | "overlay" | "gaze" | "host";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".tflite": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

const BASE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
];

export const CSP: Record<Host, string> = {
  shell: [
    ...BASE_CSP,
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
  ].join("; "),
  overlay: [...BASE_CSP, "img-src 'self' data: blob:", "connect-src 'self'", "worker-src 'self' blob:"].join(
    "; ",
  ),
  gaze: [
    ...BASE_CSP,
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
  ].join("; "),
  host: [...BASE_CSP, "img-src 'self' data:", "connect-src 'none'"].join("; "),
};

export interface ProtocolRoots {
  shell: string | null;
  overlay: string;
  gaze: string | null;
  host: string;
}

/** Resolves a URL path inside a root, refusing anything that escapes it. */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = normalize(join(root, decoded));
  const rootNorm = normalize(root.endsWith(sep) ? root : root + sep);
  if (full !== normalize(root) && !full.startsWith(rootNorm)) return null;
  return full;
}

const PROXIED = ["/api/", "/respond"];

export function createHandler(roots: () => ProtocolRoots, client: CoordinatorClient) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const host = url.hostname as Host;
    if (!["shell", "overlay", "gaze", "host"].includes(host))
      return new Response("Not found", { status: 404 });

    if (host === "shell" && PROXIED.some((p) => url.pathname.startsWith(p))) {
      return proxy(request, url, client);
    }

    const root = roots()[host];
    if (!root) return new Response(`${host} is not installed in this build`, { status: 404 });
    let file = safeJoin(root, url.pathname === "/" ? "/index.html" : url.pathname);
    if (!file) return new Response("Forbidden", { status: 403 });
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    // Single-page app: unknown paths without an extension get the shell's index.html.
    if (!info && host === "shell" && !extname(url.pathname)) {
      file = join(root, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info) return new Response("Not found", { status: 404 });
    const body = await readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Security-Policy": CSP[host],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  };
}

async function proxy(request: Request, url: URL, client: CoordinatorClient): Promise<Response> {
  const ep = client.current;
  if (!ep) return Response.json({ detail: "The coordinator is starting." }, { status: 503 });
  const headers = new Headers();
  const type = request.headers.get("Content-Type");
  if (type) headers.set("Content-Type", type);
  headers.set("Accept", request.headers.get("Accept") ?? "*/*");
  if (ep.token) headers.set("X-Agency-Token", ep.token);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const res = await fetch(`${ep.url}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      redirect: "manual",
    });
    const out = new Headers();
    for (const name of ["Content-Type", "Cache-Control", "Content-Disposition"]) {
      const v = res.headers.get(name);
      if (v) out.set(name, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  } catch {
    return Response.json({ detail: "The coordinator is not reachable." }, { status: 502 });
  }
}
