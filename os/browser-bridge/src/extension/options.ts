/** Options: pairing status and code, pairing again, and the person's extra protected sites. */

const LINK_TEXT: Record<string, string> = {
  ready: "Connected to AGENCY.",
  "waiting-for-agency": "Waiting for AGENCY to start on this Mac.",
  handshake: "Connecting to AGENCY…",
  disconnected: "AGENCY isn't installed or isn't running.",
  unpaired: "Not paired yet. Open AGENCY on this Mac.",
  mismatch: "AGENCY on this Mac has changed since pairing. If you reinstalled AGENCY, pair again below.",
};

const status = document.getElementById("status")!;
const fp = document.getElementById("fp")!;
const extra = document.getElementById("extra") as HTMLTextAreaElement;

async function refresh(): Promise<void> {
  const r = (await chrome.runtime.sendMessage({ kind: "options-status" })) as
    | { link: string; paired: boolean; fingerprint: string | null; extraProtected: string[] }
    | undefined;
  if (!r) return;
  status.textContent = LINK_TEXT[r.link] ?? r.link;
  fp.textContent = r.fingerprint ?? "none";
  if (document.activeElement !== extra) extra.value = r.extraProtected.join("\n");
}

document.getElementById("forget")!.addEventListener("click", async (e) => {
  if (!e.isTrusted) return;
  await chrome.runtime.sendMessage({ kind: "options-forget-pairing" });
  setTimeout(refresh, 800);
});

document.getElementById("save")!.addEventListener("click", async (e) => {
  if (!e.isTrusted) return;
  const hosts = extra.value
    .split(/\s+/)
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((h) => /^[a-z0-9.-]+$/.test(h));
  await chrome.storage.local.set({ extraProtected: hosts });
  await refresh();
});

chrome.runtime.onMessage.addListener((m: { kind?: string }) => {
  if (m.kind === "link-state") void refresh();
});
void refresh();

export {};
