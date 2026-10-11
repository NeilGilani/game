/**
 * The quick pack: opening a Mac app, and playing music in Music, without the AI model. These are a launch and a
 * button press, so they take a second or two instead of a model reading the screen turn by turn. Every effect still
 * goes through the guarded tools, and each step is checked by reading the app back.
 */

import type { TaskRequest } from "@agency/contracts";
import type { GuardOutcome } from "../guard";
import type { PackStep, TaskPack } from "../types";

/** Why a guarded action didn't happen, in the person's words (the pack runner stops on "not done"). */
function notDone(o: GuardOutcome<unknown>): string | null {
  if (o.status === "done") return null;
  return `not done: ${o.status === "change" ? `you asked for a change (${o.change})` : o.reason}`;
}

/** Common Mac apps by the names people use for them. Only these are opened by name. */
export const KNOWN_APPS: Record<string, string> = {
  music: "com.apple.Music",
  safari: "com.apple.Safari",
  chrome: "com.google.Chrome",
  "google chrome": "com.google.Chrome",
  mail: "com.apple.mail",
  messages: "com.apple.MobileSMS",
  facetime: "com.apple.FaceTime",
  notes: "com.apple.Notes",
  calendar: "com.apple.iCal",
  reminders: "com.apple.reminders",
  photos: "com.apple.Photos",
  maps: "com.apple.Maps",
  podcasts: "com.apple.podcasts",
  tv: "com.apple.TV",
  books: "com.apple.iBooksX",
  news: "com.apple.news",
  weather: "com.apple.weather",
  calculator: "com.apple.calculator",
  finder: "com.apple.finder",
  spotify: "com.spotify.client",
  zoom: "us.zoom.xos",
};

/** The app a request names, from the flow's choice or "Open X" / "... in the X app". */
export function appFor(request: TaskRequest): { name: string; bundleId: string } | null {
  const candidates = [
    request.selections?.app,
    /\bin (?:the )?([a-z ]+?) app\b/i.exec(request.goal)?.[1],
    /^(?:open|switch to|launch|start)\s+(?:the\s+)?([a-z ]+?)(?:\s+app)?\.?$/i.exec(request.goal.trim())?.[1],
  ];
  for (const c of candidates) {
    const name = c?.trim().toLowerCase();
    if (name && KNOWN_APPS[name])
      return { name: c!.trim().replace(/^\w/, (m) => m.toUpperCase()), bundleId: KNOWN_APPS[name]! };
  }
  return null;
}

/** Playing something in Music (the Watch & listen flow): open Music, then press its Play control. */
function wantsPlay(request: TaskRequest, bundleId: string): boolean {
  return bundleId === "com.apple.Music" && /^play\b/i.test(request.goal.trim());
}

export function createAppsPack(): TaskPack {
  return {
    id: "apps",
    title: "Open an app",
    matches: (r) =>
      appFor(r) !== null &&
      (/^(open|switch to|launch|start)\b/i.test(r.goal.trim()) || wantsPlay(r, appFor(r)!.bundleId)),
    steps: (r) => {
      const app = appFor(r)!;
      const steps: PackStep[] = [
        {
          id: "open",
          title: `Open ${app.name}`,
          risk: "read",
          run: async ({ tools }) => {
            const failed = notDone(await tools.openApp(app.bundleId));
            if (failed) return { verified: false, summary: failed };
            const front = await tools.readApp(5);
            const verified = front.owner === app.bundleId;
            return verified
              ? {
                  verified,
                  summary: `${app.name} is open.`,
                  evidence: `The frontmost app is ${app.bundleId}.`,
                }
              : { verified, summary: `${app.name} didn't come to the front yet.` };
          },
        },
      ];
      if (wantsPlay(r, app.bundleId)) {
        steps.push({
          id: "play",
          title: "Start playing",
          risk: "reversible",
          run: async ({ tools }) => {
            const before = await tools.readApp(300);
            if (before.targets.some((t) => /^pause$/i.test(t.label))) {
              return {
                verified: true,
                summary: "Music is already playing.",
                evidence: "Music shows a Pause control.",
              };
            }
            const play = before.targets.find((t) => /^play$/i.test(t.label) && /button/i.test(t.role));
            const failed = notDone(play ? await tools.press(play.id) : await tools.key("space"));
            if (failed) return { verified: false, summary: failed };
            const after = await tools.readApp(300);
            const playing = after.targets.some((t) => /^pause$/i.test(t.label));
            return playing
              ? { verified: true, summary: "Music is playing.", evidence: "Music now shows a Pause control." }
              : {
                  verified: false,
                  summary: "Music is open, but it didn't start playing (choose a song first).",
                };
          },
        });
      }
      return steps;
    },
  };
}
