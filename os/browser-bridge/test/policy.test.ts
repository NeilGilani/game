import { describe, expect, it } from "vitest";
import { classifyAction, classifyUrl, containsCardNumber, isOpenableUrl, isSecretField } from "../src/policy.ts";

describe("protected sites", () => {
  it.each([
    ["https://www.chase.com/personal", "banking"],
    ["https://secure.bankofamerica.com/login", "banking"],
    ["https://my.firstcommunitybank.com/", "banking"],
    ["https://www.paypal.com/myaccount", "banking"],
    ["http://bank.localhost:8787/", "banking"],
    ["https://my.1password.com/", "password-manager"],
    ["https://vault.bitwarden.com/", "password-manager"],
    ["https://passwords.google.com/", "password-manager"],
    ["https://accounts.google.com/signin", "account-security"],
    ["https://myaccount.google.com/security", "account-security"],
    ["https://appleid.apple.com/", "account-security"],
    ["chrome://settings/passwords", "browser-internal"],
    ["chrome-extension://abc/page.html", "browser-internal"],
    ["https://chromewebstore.google.com/detail/x", "browser-internal"],
    ["not a url", "browser-internal"],
  ])("%s is %s", (url, category) => {
    expect(classifyUrl(url)?.category).toBe(category);
  });

  it.each(["https://www.doordash.com/", "https://myaccount.google.com/personal-info", "http://food.localhost:8787/", "https://bankrate.example.org/"])(
    "%s is not protected",
    (url) => {
      expect(classifyUrl(url)).toBeNull();
    },
  );

  it("adds the person's own hosts", () => {
    expect(classifyUrl("https://portal.mycu.org/", ["mycu.org"])?.category).toBe("custom");
    expect(classifyUrl("https://evilmycu.org/", ["mycu.org"])).toBeNull();
  });

  it("only opens http and https", () => {
    expect(isOpenableUrl("https://a.example/")).toBe(true);
    for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "chrome://flags", "about:blank"]) expect(isOpenableUrl(u)).toBe(false);
  });
});

describe("secret fields", () => {
  it.each([
    [{ tag: "input", type: "password" }, true],
    [{ tag: "INPUT", type: "text", autocomplete: "one-time-code" }, true],
    [{ tag: "input", type: "text", autocomplete: "cc-number" }, true],
    [{ tag: "input", type: "text", autocomplete: "section-pay cc-csc" }, true],
    [{ tag: "input", type: "text", name: "otp" }, true],
    [{ tag: "input", type: "tel", label: "Verification code" }, true],
    [{ tag: "input", type: "text", label: "Card number" }, true],
    [{ tag: "input", type: "text", id: "cvv" }, true],
    [{ tag: "input", type: "text", label: "PIN" }, true],
    [{ tag: "input", type: "text", label: "Full name" }, false],
    [{ tag: "input", type: "email", autocomplete: "email" }, false],
    [{ tag: "input", type: "text", label: "Spinach quantity" }, false],
    [{ tag: "select", label: "Password hint" }, false],
  ])("%j -> %s", (f, secret) => {
    expect(isSecretField(f)).toBe(secret);
  });
});

describe("card numbers in text", () => {
  it("finds Luhn-valid card numbers however they're written", () => {
    expect(containsCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(containsCardNumber("my card is 4111-1111-1111-1111 thanks")).toBe(true);
    expect(containsCardNumber("378282246310005")).toBe(true);
  });
  it("ignores ordinary numbers", () => {
    expect(containsCardNumber("Order DD-1001, total $21.22")).toBe(false);
    expect(containsCardNumber("Call 415 555 0100")).toBe(false);
    expect(containsCardNumber("4242 4242 4242 4241")).toBe(false); // fails Luhn
    expect(containsCardNumber("RX-204118 and RX-204377")).toBe(false);
  });
});

describe("consequential actions", () => {
  const button = (name: string, extra: Partial<Parameters<typeof classifyAction>[0]> = {}) =>
    classifyAction({ role: "button", name, submitsForm: false, ...extra });
  it.each([
    ["Place order", "purchase"],
    ["Pay now", "purchase"],
    ["Buy now", "purchase"],
    ["Send", "send"],
    ["Reply all", "send"],
    ["Delete", "delete"],
    ["Cancel order", "delete"],
    ["Sign and submit application", "sign"],
    ["Save settings", "account-or-settings"],
    ["Add to Chrome", "install"],
    ["Submit refill request", "submit"],
    ["Book appointment", "submit"],
  ])("%s is %s", (name, kind) => {
    expect(button(name)).toBe(kind);
  });

  it.each(["Add to cart · $15.00", "Search", "Save and continue", "Review refill request", "Update tip", "Remove Pad thai", "Next", "Back"])(
    "%s doesn't need approval",
    (name) => {
      expect(button(name, { submitsForm: true, formMethod: "post" })).toBeNull();
    },
  );

  it("treats other posted forms as submissions, including signing in with saved credentials, but not searches", () => {
    expect(button("Sign in", { submitsForm: true, formMethod: "post" })).toBe("submit");
    expect(button("Ask Dr. Lee for a refill", { submitsForm: true, formMethod: "post" })).toBe("submit");
    expect(button("Go", { submitsForm: true, formMethod: "get" })).toBeNull();
  });

  it("links only count for unmistakable actions", () => {
    expect(classifyAction({ role: "link", name: "Forward", submitsForm: false })).toBeNull();
    expect(classifyAction({ role: "link", name: "Buy now", submitsForm: false })).toBe("purchase");
    expect(classifyAction({ role: "heading", name: "Place order", submitsForm: false })).toBeNull();
  });
});
