import { afterEach, describe, expect, it, vi } from "vitest";
import { askQuestion, readEvents, type FusionEvent } from "../src/api/synapse";

afterEach(() => vi.unstubAllGlobals());

function streamOf(text: string, bytesPerChunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += bytesPerChunk) {
        controller.enqueue(bytes.slice(offset, offset + bytesPerChunk));
      }
      controller.close();
    },
  });
}

describe("Synapse-Mesh streaming questions", () => {
  it("preserves Unicode and records split across chunks, including an EOF without newline", async () => {
    const events: FusionEvent[] = [];
    await readEvents(
      streamOf('\n{"event":"token","text":"你好 🧠"}\n{"event":"response","text":"你好"}', 1),
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { event: "token", text: "你好 🧠" },
      { event: "response", text: "你好" },
    ]);
  });

  it("sends only the question and null cap with the configured coordinator token", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "agency.token" ? "test-token" : "http://coordinator.test/"),
    });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          streamOf('{"event":"response","text":"Answer"}\n{"event":"complete","base_restored":true}\n'),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await askQuestion("Explain software licensing", null, signal, () => undefined);
    expect(fetch).toHaveBeenCalledWith(
      "http://coordinator.test/api/synapse/questions",
      expect.objectContaining({
        signal,
        body: JSON.stringify({ question: "Explain software licensing", max_new_tokens: null }),
        headers: { "Content-Type": "application/json", "X-Agency-Token": "test-token" },
      }),
    );
  });

  it.each([
    ['{"event":"token","text":"Partial"}\n', "before the answer finished"],
    [
      '{"event":"response","text":"Answer"}\n{"event":"complete","base_restored":false}\n',
      "didn't finish correctly",
    ],
    ['{"event":"error","message":"Missing adapter"}\n', "Missing adapter"],
  ])("does not label an incomplete stream as an answer", async (text, error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(streamOf(text))));
    await expect(askQuestion("Question", 512, new AbortController().signal, () => undefined)).rejects.toThrow(
      error,
    );
  });

  it("surfaces connection errors and closes the stream when an error event arrives", async () => {
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"event":"error","message":"Kernel offline"}\n'));
      },
      cancel() {
        closed = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    await expect(
      askQuestion("Question", null, new AbortController().signal, () => undefined),
    ).rejects.toThrow("Kernel offline");
    expect(closed).toBe(true);
  });
});
