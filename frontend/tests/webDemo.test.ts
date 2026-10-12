import { describe, expect, it } from "vitest";
import { StandIn } from "../src/demo/webDemo";

describe("the web demo's in-page coordinator", () => {
  it("answers what the interface polls", () => {
    const standIn = new StandIn();
    for (const path of [
      "/api/health",
      "/api/runtime",
      "/api/preferences",
      "/api/lifeline/status",
      "/api/lifeline/settings",
      "/api/lifeline/report",
      "/api/synapse",
    ]) {
      expect(standIn.handle("GET", path, null).status, path).toBe(200);
    }
  });

  it("doesn't offer presenter controls it can't carry out", () => {
    // The recording comes from a coordinator with presenter controls on, but the stand-in has no faults or network
    // override: offering them made the Lifeline screen call GET/PUT /api/demo/faults and get 404s.
    const standIn = new StandIn();
    const health = standIn.handle("GET", "/api/health", null).body as { demo_controls: boolean };
    const runtime = standIn.handle("GET", "/api/runtime", null).body as {
      settings: { demo_controls: boolean };
    };
    expect(health.demo_controls).toBe(false);
    expect(runtime.settings.demo_controls).toBe(false);
    expect(standIn.handle("GET", "/api/demo/faults", null).body).toMatchObject({
      lifeline_primary_unreachable: false,
    });
    expect(standIn.handle("PUT", "/api/demo/faults", { lifeline_primary_unreachable: true }).status).toBe(
      404,
    );
  });
});
