/** HTTP client for the coordinator (bundled sidecar, a Raspberry Pi, or an external dev server). */

export interface CoordinatorEndpoint {
  mode: "bundled" | "remote" | "external";
  url: string;
  /** Sent as X-Agency-Token. Kept in the main process only; never given to a renderer. */
  token: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CoordinatorClient {
  private endpoint: CoordinatorEndpoint | null = null;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  set(endpoint: CoordinatorEndpoint | null): void {
    this.endpoint = endpoint ? { ...endpoint, url: endpoint.url.replace(/\/+$/, "") } : null;
  }

  get current(): CoordinatorEndpoint | null {
    return this.endpoint;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.endpoint?.token) h["X-Agency-Token"] = this.endpoint.token;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 4_000): Promise<T> {
    const ep = this.endpoint;
    if (!ep) throw new Error("No coordinator configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${ep.url}${path}`, {
        method,
        headers: this.headers(),
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthy(timeoutMs = 2_000): Promise<boolean> {
    try {
      await this.request("GET", "/api/health", undefined, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }
}
