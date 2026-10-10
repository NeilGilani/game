/**
 * The person's own answer to "Let AGENCY help on this protected site?". This page belongs to the
 * extension, so neither web pages nor AGENCY's commands can press its buttons; only a real click or a
 * real key press (event.isTrusted) counts. Following the safety constitution, "Yes" is placed away from
 * where the question appears and only becomes available after a pause.
 */

const q = new URLSearchParams(location.search);
const req = q.get("req") ?? "";
const origin = q.get("origin") ?? "";
const category = q.get("category") ?? "";

const WHY: Record<string, string> = {
  banking: "It looks like a bank or payment site.",
  "password-manager": "It is a password manager.",
  "account-security": "It is an account sign-in or security page.",
  custom: "You added it to your protected sites.",
};

const site = document.getElementById("site");
if (site)
  site.textContent = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  })();
const why = document.getElementById("why");
if (why)
  why.textContent = `${WHY[category] ?? "It is a protected site."} AGENCY doesn't use it unless you say so.`;

const yes = document.getElementById("yes") as HTMLButtonElement;
const no = document.getElementById("no") as HTMLButtonElement;
const hint = document.getElementById("hint");

setTimeout(() => {
  yes.disabled = false;
  if (hint) hint.textContent = "Choose one. There is no time limit.";
}, 1500);

function answer(allowed: boolean, e: Event): void {
  chrome.runtime
    .sendMessage({ kind: "allowance-answer", req, allowed, trusted: e.isTrusted })
    .catch(() => undefined);
}
yes.addEventListener("click", (e) => {
  if (!e.isTrusted || yes.disabled) return;
  answer(true, e);
});
no.addEventListener("click", (e) => answer(false, e));

export {};
