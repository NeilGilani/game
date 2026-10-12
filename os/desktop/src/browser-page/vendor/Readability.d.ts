// Types for the vendored Mozilla Readability (from its own index.d.ts, trimmed to what AGENCY uses).
export class Readability<T = string> {
  constructor(
    document: Document,
    options?: {
      charThreshold?: number;
      maxElemsToParse?: number;
      serializer?: (node: Node) => T;
      disableJSONLD?: boolean;
    },
  );
  parse(): null | {
    title: string | null | undefined;
    content: T | null | undefined;
    textContent: string | null | undefined;
    length: number | null | undefined;
    excerpt: string | null | undefined;
    byline: string | null | undefined;
    siteName: string | null | undefined;
    lang: string | null | undefined;
  };
}
