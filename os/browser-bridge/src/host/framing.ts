/**
 * Chrome native messaging framing: each message is UTF-8 JSON preceded by its byte length as a 32-bit
 * integer in native byte order (little-endian on every Mac Chrome supports). Chrome -> host messages can
 * be up to 64 MiB; host -> Chrome messages at most 1 MB.
 */

export const MAX_TO_CHROME = 1024 * 1024;
export const MAX_FROM_CHROME = 64 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_TO_CHROME) throw new Error(`Message too large for Chrome (${json.length} bytes).`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Incremental decoder: push chunks from stdin, get complete messages out. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FROM_CHROME) throw new Error(`Frame of ${len} bytes is larger than Chrome allows.`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body));
    }
    return out;
  }
}

/** Newline-delimited JSON for the Unix socket between the host and AGENCY. */
export class LineDecoder {
  private buf = "";

  constructor(private readonly maxLine = MAX_FROM_CHROME) {}

  push(chunk: Buffer | string): string[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.buf.length > this.maxLine && !this.buf.includes("\n")) throw new Error("Line too long.");
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.filter((l) => l.trim().length > 0);
  }
}
