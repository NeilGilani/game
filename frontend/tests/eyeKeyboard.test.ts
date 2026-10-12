import { describe, expect, it } from "vitest";
import { SYMBOL_ROWS, startsWithDigits } from "../src/components/EyeKeyboard";

describe("the eye keyboard can fill in emails, web addresses and phone numbers", () => {
  it("its 123 keys have every digit and what addresses, emails and phone numbers need", () => {
    const keys = SYMBOL_ROWS.join("");
    for (const k of "0123456789@-_/:.+") expect(keys).toContain(k);
    // Keys stay as big as the letters: no row longer than the longest letter row.
    for (const row of SYMBOL_ROWS) expect(row.length).toBeLessThanOrEqual(10);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("phone numbers, PINs and numbers start on the digits; text, email and web addresses on the letters", () => {
    expect(startsWithDigits({ type: "tel", inputMode: "" })).toBe(true);
    expect(startsWithDigits({ type: "number", inputMode: "" })).toBe(true);
    expect(startsWithDigits({ type: "text", inputMode: "tel" })).toBe(true);
    expect(startsWithDigits({ type: "text", inputMode: "numeric" })).toBe(true);
    expect(startsWithDigits({ type: "text", inputMode: "" })).toBe(false);
    expect(startsWithDigits({ type: "email", inputMode: "" })).toBe(false);
    expect(startsWithDigits({ type: "text", inputMode: "url" })).toBe(false);
    expect(startsWithDigits({ type: "textarea", inputMode: "" })).toBe(false);
  });
});
