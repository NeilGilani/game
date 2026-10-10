import { describe, expect, it } from "vitest";
import { FrameDecoder, LineDecoder, MAX_TO_CHROME, encodeFrame } from "../src/host/framing.ts";

describe("native messaging framing", () => {
  it("round-trips messages split across chunks", () => {
    const a = encodeFrame({ k: "hello", n: "ünïcødé ✓" });
    const b = encodeFrame({ k: "x", list: [1, 2, 3] });
    const all = Buffer.concat([a, b]);
    const d = new FrameDecoder();
    const out = [...d.push(all.subarray(0, 3)), ...d.push(all.subarray(3, a.length + 5)), ...d.push(all.subarray(a.length + 5))];
    expect(out).toEqual([{ k: "hello", n: "ünïcødé ✓" }, { k: "x", list: [1, 2, 3] }]);
  });
  it("uses the byte length, not the character count", () => {
    const f = encodeFrame("é");
    expect(f.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify("é")));
  });
  it("refuses messages over Chrome's 1 MB limit", () => {
    expect(() => encodeFrame("x".repeat(MAX_TO_CHROME))).toThrow(/too large/);
  });
  it("refuses absurd frame lengths", () => {
    const h = Buffer.alloc(4);
    h.writeUInt32LE(0xffffffff, 0);
    expect(() => new FrameDecoder().push(h)).toThrow();
  });
  it("splits socket lines", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(':2}\n\n')).toEqual(['{"b":2}']);
  });
});
