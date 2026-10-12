import { describe, expect, it } from "vitest";
import { HttpMemoryClient } from "../src/memory";

describe("HttpMemoryClient", () => {
  it("sends the coordinator token the way the coordinator checks it (X-Agency-Token)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ label: "Pad thai", reason: "usual" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new HttpMemoryClient("http://127.0.0.1:8000", "tok", fetchImpl);
    expect(await client.suggestions("food", 3)).toHaveLength(1);
    await client.log({ path: ["food", "Pad thai"], surface: "food", outcome: "chosen" });
    for (const c of calls) {
      const headers = c.init.headers as Record<string, string>;
      expect(headers["x-agency-token"]).toBe("tok");
      expect(headers.authorization).toBeUndefined();
    }
    expect(calls[0]!.url).toBe("http://127.0.0.1:8000/api/memory/suggestions?surface=food&limit=3");
  });
});
