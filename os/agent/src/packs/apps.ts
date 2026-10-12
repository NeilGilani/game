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

type App = { name: string; bundleId: string };

function known(candidate: string | undefined): App | null {
  const name = candidate?.trim().toLowerCase();
  if (!name || !KNOWN_APPS[name]) return null;
  return { name: candidate!.trim().replace(/^\w/, (m) => m.toUpperCase()), bundleId: KNOWN_APPS[name]! };
}

/** The whole goal is "Open X" (or switch to / launch / start), nothing more. */
const OPEN_GOAL = /^(?:open|switch to|launch|start)\s+(?:the\s+)?([a-z ]+?)(?:\s+app)?\.?$/i;

/** The app a goal asks to open and nothing else ("Open Notes"), or null ("Open a note in the Notes app and…"). */
export function appToOpen(request: TaskRequest): App | null {
  return known(OPEN_GOAL.exec(request.goal.trim())?.[1]);
}

/** The app a request names, from "Open X", the flow's choice or "... in the X app". */
export function appFor(request: TaskRequest): App | null {
  return (
    appToOpen(request) ??
    known(request.selections?.app) ??
    known(/\bin (?:the )?([a-z ]+?) app\b/i.exec(request.goal)?.[1])
  );
}

/** Playing something in Music (the Watch & listen flow): open Music, then press its Play control. */
function wantsPlay(request: TaskRequest, bundleId: string): boolean {
  return bundleId === "com.apple.Music" && /^play\b/i.test(request.goal.trim());
}

const PAUSE = /^pause$/i;

export function createAppsPack(opts: { settleMs?: number; checks?: number } = {}): TaskPack {
  const settleMs = opts.settleMs ?? 300;
  const checks = opts.checks ?? 5;
  return {
    id: "apps",
    title: "Open an app",
    // Only a goal that is just "Open X", or playing in Music. Anything more ("Open a new note in the Notes app and
    // write…") is left to the model: opening the app alone would report a task done that wasn't.
    matches: (r) => {
      if (appToOpen(r)) return true;
      const app = appFor(r);
      return app !== null && wantsPlay(r, app.bundleId);
    },
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
            // A cold start takes a moment: look a few times before trying the launch again.
            let verified = false;
            for (let i = 0; i < checks && !verified; i++) {
              if (i > 0) await new Promise((r) => setTimeout(r, settleMs));
              verified = (await tools.readApp(5)).owner === app.bundleId;
            }
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
            let before = await tools.readApp(300);
            // The Play button and the space bar act on whatever app is in front: make sure that is Music, or a
            // "Play" in another app (or a key press into AGENCY itself) would be the one pressed.
            if (before.owner !== app.bundleId) {
              const failed = notDone(await tools.openApp(app.bundleId));
              if (failed) return { verified: false, summary: failed };
              before = await tools.readApp(300);
              if (before.owner !== app.bundleId)
                return { verified: false, summary: `${app.name} isn't in front, so I didn't press Play.` };
            }
            if (before.targets.some((t) => PAUSE.test(t.label))) {
              return {
                verified: true,
                summary: "Music is already playing.",
                evidence: "Music shows a Pause control.",
              };
            }
            const play = before.targets.find((t) => /^play$/i.test(t.label) && /button/i.test(t.role));
            const failed = notDone(play ? await tools.press(play.id) : await tools.key("space"));
            if (failed) return { verified: false, summary: failed };
            // Music takes a moment to swap Play for Pause: look a few times before deciding it didn't start.
            for (let i = 0; i < checks; i++) {
              if (i > 0) await new Promise((r) => setTimeout(r, settleMs));
              const after = await tools.readApp(300);
              if (after.owner === app.bundleId && after.targets.some((t) => PAUSE.test(t.label)))
                return {
                  verified: true,
                  summary: "Music is playing.",
                  evidence: "Music now shows a Pause control.",
                };
            }
            return {
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
