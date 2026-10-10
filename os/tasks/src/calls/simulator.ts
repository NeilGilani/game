/**
 * The call simulator: scripted other parties (a pharmacy, a doctor's office, family) for demos
 * and tests. Nothing here touches a phone network. Fictional numbers use the 555-01xx range,
 * which is reserved for fiction in North America.
 */

import type { CallSession, CallState, CallTransport, DialOptions, RemoteLine } from "./transport";

export interface ScriptNode {
  id: string;
  /** What the other party says when this node is reached. */
  say: string;
  /** Suggested replies offered to the person. */
  replies: string[];
  /** Where to go after the person speaks. Return null to hang up after `say`. */
  next: (personSaid: string) => string | null;
}

export interface PartyScript {
  id: string;
  name: string;
  number: string;
  kind: "pharmacy" | "doctor" | "family" | "voicemail";
  start: string;
  nodes: Record<string, ScriptNode>;
}

const has = (said: string, ...words: string[]) => words.some((w) => said.toLowerCase().includes(w));

export const PHARMACY: PartyScript = {
  id: "pharmacy",
  name: "Maple Street Pharmacy (simulated)",
  number: "+15555550142",
  kind: "pharmacy",
  start: "greet",
  nodes: {
    greet: {
      id: "greet",
      say: "Maple Street Pharmacy, this is Sam. Thanks for letting me know about the voice. How can I help?",
      replies: [
        "I'd like to refill a prescription",
        "I have a question about my medicine",
        "Is my order ready?",
      ],
      next: (s) =>
        has(s, "refill", "ready", "order") ? "name" : has(s, "question") ? "question" : "clarify",
    },
    clarify: {
      id: "clarify",
      say: "Sorry, I didn't catch that. Are you calling about a refill?",
      replies: ["Yes, a refill", "No, a question"],
      next: (s) => (has(s, "no", "question") ? "question" : "name"),
    },
    question: {
      id: "question",
      say: "Sure. Our pharmacist can call you back today. Is that OK?",
      replies: ["Yes, please call me back", "No, thank you"],
      next: (s) => (has(s, "no") ? "bye" : "callback"),
    },
    callback: {
      id: "callback",
      say: "Great, I've put in a callback request. Anything else?",
      replies: ["No, that's all. Thank you", "Yes, a refill too"],
      next: (s) => (has(s, "refill") ? "name" : "bye"),
    },
    name: {
      id: "name",
      say: "Happy to help. Can I have your name and date of birth?",
      replies: [],
      next: () => "which",
    },
    which: {
      id: "which",
      say: "Thanks, I found you. Which prescription would you like refilled?",
      replies: ["My usual prescription", "All of them, please"],
      next: () => "when",
    },
    when: {
      id: "when",
      say: "That one has refills left. It'll be ready tomorrow after 2 pm. Would you like pickup or delivery?",
      replies: ["Delivery, please", "Someone will pick it up"],
      next: (s) => (has(s, "deliver") ? "delivery" : "pickup"),
    },
    delivery: {
      id: "delivery",
      say: "Delivery to the address on file, tomorrow evening. There's no charge. Anything else?",
      replies: ["No, that's all. Thank you", "Can you text me when it's on the way?"],
      next: (s) => (has(s, "text") ? "text" : "bye"),
    },
    pickup: {
      id: "pickup",
      say: "Got it, it'll be at the counter tomorrow after 2. Anything else?",
      replies: ["No, that's all. Thank you"],
      next: () => "bye",
    },
    text: {
      id: "text",
      say: "Sure, we'll text the number on file. Anything else?",
      replies: ["No, that's all. Thank you"],
      next: () => "bye",
    },
    bye: { id: "bye", say: "You're welcome. Take care, goodbye!", replies: [], next: () => null },
  },
};

export const DOCTOR: PartyScript = {
  id: "doctor",
  name: "Lakeside Family Clinic (simulated)",
  number: "+15555550123",
  kind: "doctor",
  start: "greet",
  nodes: {
    greet: {
      id: "greet",
      say: "Lakeside Family Clinic, front desk. How can I help you today?",
      replies: [
        "I'd like to book an appointment",
        "I need to change an appointment",
        "I'd like a call back from the nurse",
      ],
      next: (s) =>
        has(s, "book", "appointment") && !has(s, "change") ? "reason" : has(s, "change") ? "change" : "nurse",
    },
    reason: {
      id: "reason",
      say: "Of course. Is this for a check-up, or for something specific?",
      replies: ["A regular check-up", "Something specific"],
      next: () => "slots",
    },
    slots: {
      id: "slots",
      say: "I have Tuesday at 10 am, Wednesday at 2:30 pm, or Friday at 9 am. Which works?",
      replies: ["Tuesday at 10 am", "Wednesday at 2:30 pm", "Friday at 9 am", "None of those work"],
      next: (s) => (has(s, "none") ? "later" : "confirm"),
    },
    later: {
      id: "later",
      say: "The next openings are Monday at 11 am or Thursday at 4 pm.",
      replies: ["Monday at 11 am", "Thursday at 4 pm", "I'll call back later"],
      next: (s) => (has(s, "call back") ? "bye" : "confirm"),
    },
    confirm: {
      id: "confirm",
      say: "You're booked. Please arrive 10 minutes early. Do you need wheelchair access or any other help at the visit?",
      replies: ["Yes, wheelchair access please", "No, thank you"],
      next: () => "bye",
    },
    change: {
      id: "change",
      say: "Sure. Do you want to move it or cancel it?",
      replies: ["Move it, please", "Cancel it, please"],
      next: (s) => (has(s, "cancel") ? "cancelled" : "slots"),
    },
    cancelled: {
      id: "cancelled",
      say: "It's cancelled. Anything else?",
      replies: ["No, that's all. Thank you"],
      next: () => "bye",
    },
    nurse: {
      id: "nurse",
      say: "I'll ask the nurse to call you back this afternoon. Anything else?",
      replies: ["No, that's all. Thank you"],
      next: () => "bye",
    },
    bye: { id: "bye", say: "Thanks for calling. Goodbye!", replies: [], next: () => null },
  },
};

export const FAMILY: PartyScript = {
  id: "family",
  name: "Jordan (simulated)",
  number: "+15555550177",
  kind: "family",
  start: "greet",
  nodes: {
    greet: {
      id: "greet",
      say: "Hey! It's so good to hear from you. How are you doing today?",
      replies: ["I'm doing well", "I'm tired today", "I miss you"],
      next: () => "chat",
    },
    chat: {
      id: "chat",
      say: "I'm thinking of coming over on Saturday. Would that be OK?",
      replies: ["Yes, please come!", "Sunday would be better", "Not this weekend"],
      next: (s) => (has(s, "not") ? "okay" : "bring"),
    },
    bring: {
      id: "bring",
      say: "Great. Do you want me to bring anything?",
      replies: ["Bring a movie", "Just you", "Some snacks would be nice"],
      next: () => "love",
    },
    okay: {
      id: "okay",
      say: "No problem, another time. I'll call you next week.",
      replies: ["Talk soon", "Love you"],
      next: () => "love",
    },
    love: { id: "love", say: "Love you. Talk soon, bye!", replies: [], next: () => null },
  },
};

export const VOICEMAIL: PartyScript = {
  id: "voicemail",
  name: "Voicemail (simulated)",
  number: "",
  kind: "voicemail",
  start: "beep",
  nodes: {
    beep: {
      id: "beep",
      say: "The person you are calling isn't available. Please leave a message after the tone.",
      replies: ["Please call me back", "Just checking in. Talk soon"],
      next: () => "saved",
    },
    saved: { id: "saved", say: "Message saved. Goodbye.", replies: [], next: () => null },
  },
};

export const SIMULATED_PARTIES: PartyScript[] = [PHARMACY, DOCTOR, FAMILY];

let callCounter = 0;

class SimulatedCall implements CallSession {
  readonly id: string;
  readonly simulated = true;
  state: CallState = "dialing";
  /** Everything said, for tests only. Nothing is stored after the call. */
  readonly said: { who: "person" | "party"; text: string }[] = [];
  private node: ScriptNode | null = null;
  private readonly remoteListeners = new Set<(line: RemoteLine) => void>();
  private readonly stateListeners = new Set<(state: CallState, reason?: string) => void>();
  private disclosed = false;

  constructor(
    readonly to: string,
    private readonly script: PartyScript,
    private readonly options: DialOptions,
    private readonly delayMs: number,
  ) {
    callCounter += 1;
    this.id = `sim-call-${callCounter}`;
  }

  private wait(): Promise<void> {
    return this.delayMs > 0 ? new Promise((r) => setTimeout(r, this.delayMs)) : Promise.resolve();
  }

  private setState(state: CallState, reason?: string): void {
    this.state = state;
    for (const l of this.stateListeners) l(state, reason);
  }

  async connect(): Promise<void> {
    await this.wait();
    if (this.state === "ended") return;
    this.setState("ringing");
    await this.wait();
    // hangUp() may have run while waiting.
    if ((this.state as CallState) === "ended") return;
    this.setState("connected");
  }

  private async speakNode(id: string | null): Promise<void> {
    if (id === null) {
      this.node = null;
      await this.wait();
      if (this.state !== "ended") this.setState("ended", "The other person hung up.");
      return;
    }
    const node = this.script.nodes[id];
    if (!node) throw new Error(`Script ${this.script.id} has no node ${id}`);
    this.node = node;
    await this.wait();
    if (this.state !== "connected") return;
    this.said.push({ who: "party", text: node.say });
    for (const l of this.remoteListeners) l({ text: node.say, final: true, suggestions: node.replies });
    if (node.next("") === null && node.replies.length === 0) await this.speakNode(null);
  }

  async say(text: string): Promise<void> {
    if (this.state !== "connected") throw new Error("The call isn't connected.");
    this.said.push({ who: "person", text });
    if (!this.disclosed) {
      // The script only starts once the disclosure has been spoken.
      if (text !== this.options.disclosure) throw new Error("The disclosure must be spoken first.");
      this.disclosed = true;
      void this.speakNode(this.script.start);
      return;
    }
    const node = this.node;
    if (!node) return;
    void this.speakNode(node.next(text));
  }

  onRemote(listener: (line: RemoteLine) => void): () => void {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  onState(listener: (state: CallState, reason?: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async hangUp(): Promise<void> {
    if (this.state !== "ended") this.setState("ended", "You hung up.");
  }
}

export class SimulatedTransport implements CallTransport {
  readonly kind = "simulated" as const;
  readonly calls: SimulatedCall[] = [];
  constructor(
    private readonly parties: PartyScript[] = SIMULATED_PARTIES,
    private readonly delayMs = 0,
  ) {}

  async dial(e164: string, options: DialOptions): Promise<CallSession> {
    const script = this.parties.find((p) => p.number === e164) ?? VOICEMAIL;
    const call = new SimulatedCall(e164, script, options, this.delayMs);
    this.calls.push(call);
    await call.connect();
    return call;
  }
}
