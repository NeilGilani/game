/**
 * The Talk pack: say something out loud for the person, for agents and flows that want to
 * speak (Talk itself speaks directly). Speaking in the room is reversible; nothing is sent.
 */

import type { TaskRequest } from "../contracts";
import { PolicyRefusal, type PackContext, type PackOutcome, type TaskPack } from "../core/pack";
import type { MemoryClient } from "../memory/client";
import { containsCardNumber } from "../policy/secrets";
import type { Speaker } from "../talk/speech";

export interface TalkPackDeps {
  speaker: Speaker;
  memory?: MemoryClient;
  voiceId?: () => string | undefined;
}

export function createTalkPack({ speaker, memory, voiceId }: TalkPackDeps): TaskPack {
  return {
    id: "talk",
    title: "Say it out loud",
    description: "Speak a phrase aloud with the person's voice.",
    surfaces: ["talk"],
    goals: ["Say good morning", "Tell them I need a minute"],
    tools: [{ name: "speech.say", description: "Speak the text aloud in the room", risk: "reversible" }],
    policies: [
      { id: "own-words", rule: "Says only the words the person chose." },
      { id: "no-card-numbers", rule: "Never speaks a payment card number." },
    ],
    approvals: [],
    verification: [{ check: "The speech engine reports the text was spoken." }],
    honesty: {
      real: ["Calls agency-native speech.say (or the Web Speech API) with the person's chosen voice."],
      simulated: [],
      untested: ["Personal Voice on a real Mac: depends on agency-native (Instance 3) and the macOS runner."],
    },
    matches: (r: TaskRequest) => (r.origin === "talk" || /^(say|tell|speak)\b/i.test(r.goal) ? 0.6 : 0),
    async run(ctx: PackContext, request: TaskRequest): Promise<PackOutcome> {
      const text = (request.selections?.text ?? "").trim();
      if (!text) throw new PolicyRefusal("There's nothing to say yet.", "own-words");
      if (containsCardNumber(text))
        throw new PolicyRefusal("AGENCY won't say a card number out loud.", "no-card-numbers");
      ctx.plan([{ id: "say", title: `Say “${text}”`, risk: "reversible" }]);
      const v = voiceId?.();
      const ok = await ctx.exec("speech.say", { text }, () => speaker.say(text, v ? { voiceId: v } : {}));
      ctx.step("say", ok ? "done" : "failed", ok ? "Spoken" : "The voice didn't work");
      if (ok) void memory?.log({ path: ["talk", text], surface: "talk", outcome: "completed" });
      return {
        outcome: ok ? `Said “${text}”.` : "The voice didn't work, so nothing was said.",
        verified: ok,
      };
    },
  };
}
