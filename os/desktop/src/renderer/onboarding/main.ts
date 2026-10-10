/**
 * First-run setup: one permission per screen, in plain language, with live status. Works by gaze dwell, mouse and
 * keyboard. Progress is saved after every step, so a helper can start it and the person can finish it later.
 */

import type { AgencyApi, PermissionState, Target } from "@agency/contracts";
import { EXPLANATIONS, PERMISSION_KINDS } from "../../main/permissions";
import { DwellTracker } from "../shared/dwell";

declare global {
  interface Window {
    agency: AgencyApi;
  }
}

const agency = window.agency;
const STEPS = ["welcome", ...PERMISSION_KINDS, "done"] as const;
type Step = (typeof STEPS)[number];

const $ = (id: string) => document.getElementById(id)!;
const STATE_TEXT: Record<PermissionState, string> = {
  granted: "Allowed ✓",
  denied: "Not allowed yet. Open System Settings and switch AGENCY on.",
  "not-determined": "Not set up yet.",
};

let poll: number | undefined;

async function complete(s: Step): Promise<void> {
  await agency.host.completeOnboardingStep(s);
  const i = STEPS.indexOf(s);
  if (s !== "done") void show(STEPS[i + 1] ?? "done");
}

function button(label: string, onPress: () => void, primary = false, testId?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (primary) b.className = "primary";
  if (testId) b.dataset.testid = testId;
  const ring = document.createElement("span");
  ring.className = "ring";
  ring.setAttribute("aria-hidden", "true");
  b.append(ring);
  b.addEventListener("click", onPress);
  return b;
}

async function show(next: Step): Promise<void> {
  clearInterval(poll);
  const actions = $("actions");
  actions.replaceChildren();
  const index = STEPS.indexOf(next);
  $("count").textContent =
    next === "welcome" || next === "done" ? "" : `Step ${index} of ${PERMISSION_KINDS.length}`;
  $("state").textContent = "";
  $("state").className = "state";

  if (next === "welcome") {
    $("title").textContent = "Welcome to AGENCY";
    $("why").textContent =
      "AGENCY lets you use this Mac with your eyes. First it needs a few permissions from macOS. Each one is explained in plain words.";
    actions.append(button("Start", () => void complete("welcome"), true, "onboarding-start"));
    return;
  }
  if (next === "done") {
    $("title").textContent = "All set";
    $("why").textContent =
      "You can change any of these later in Settings. Help and Stop are always in the corner of the screen.";
    actions.append(button("Go to Home", () => void complete("done"), true, "onboarding-finish"));
    return;
  }
  const info = EXPLANATIONS[next];
  $("title").textContent = info.title;
  $("why").textContent = info.why + (info.required ? "" : " You can skip this and turn it on later.");
  const refresh = async () => {
    const status = await agency.permissions.status();
    const st = status[next];
    $("state").textContent = STATE_TEXT[st];
    $("state").className = `state ${st}`;
  };
  actions.append(
    button("Allow", () => void agency.permissions.request(next).then(refresh), true, "onboarding-allow"),
    button(
      "Open System Settings",
      () => void agency.permissions.openSettings(next),
      false,
      "onboarding-settings",
    ),
    button(info.required ? "Next" : "Skip for now", () => void complete(next), false, "onboarding-next"),
  );
  await refresh();
  // Live status: macOS changes happen in System Settings, outside AGENCY.
  poll = window.setInterval(() => void refresh(), 1500);
}

// Gaze dwell on the buttons, using the shell window's position on screen.
const dwell = new DwellTracker({ dwellMs: 1200 });
agency.gaze.onEvent((ev) => {
  if (ev.type !== "sample") return;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("#actions button")];
  const targets: Target[] = buttons.map((b, i) => {
    const r = b.getBoundingClientRect();
    return {
      id: String(i),
      label: b.textContent ?? "",
      role: "button",
      source: "shell",
      rect: { x: window.screenX + r.left, y: window.screenY + r.top, width: r.width, height: r.height },
    };
  });
  const res = dwell.update(ev.sample, targets);
  buttons.forEach((b, i) =>
    b.style.setProperty("--progress", res.current?.id === String(i) ? String(res.progress) : "0"),
  );
  if (res.selected) buttons[Number(res.selected.id)]?.click();
});

void agency.host.onboarding().then((state) => {
  const first = STEPS.find((s) => !state.completedSteps.includes(s)) ?? "done";
  void show(first);
});
