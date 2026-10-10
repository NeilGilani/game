import { describe, expect, it } from "vitest";
import { SignedChannel, hmacKey, tokenFingerprint } from "../src/auth.ts";

const T = "a".repeat(64);

describe("signed channel", () => {
  it("accepts in-order messages and rejects wrong direction, session or token", async () => {
    const key = await hmacKey(T);
    const app = new SignedChannel(key, "s1", ["cmd"]);
    const ext = new SignedChannel(key, "s1", ["res", "evt"]);
    const m1 = await app.seal("cmd", { n: 1 });
    const m2 = await app.seal("cmd", { n: 2 });
    expect(await ext.open(m2)).toEqual({ n: 2 });
    expect(await ext.open(m1)).toBeNull(); // older seq after a newer one
    expect(await ext.open(m2)).toBeNull(); // replay
    expect(await app.open(await app.seal("cmd", {}))).toBeNull(); // own direction bounced back
    const other = new SignedChannel(key, "s2", ["res", "evt"]);
    expect(await other.open(await app.seal("cmd", {}))).toBeNull(); // another session
    const wrong = new SignedChannel(await hmacKey("b".repeat(64)), "s1", ["res", "evt"]);
    expect(await wrong.open(await app.seal("cmd", {}))).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    await expect(hmacKey("short")).rejects.toThrow();
  });

  it("shows a short pairing code, never the token", async () => {
    const code = await tokenFingerprint(T);
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(T.toUpperCase()).not.toContain(code.replace("-", ""));
  });
});
