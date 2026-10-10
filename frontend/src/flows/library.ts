/**
 * The flows behind Home's tiles. Places, people and prices are fictional demo data; everything the agent does with
 * them happens in the sandbox and is simulated until the person configures real services.
 */
import type { FlowDef, FlowOption, Selections } from "./types";

// ---- Food -------------------------------------------------------------------------------------------------------

const MENUS: Record<string, { label: string; price: string; glyph: string }[]> = {
  "Thai Basil": [
    { label: "Pad thai", price: "$24.80", glyph: "🍜" },
    { label: "Green curry", price: "$22.50", glyph: "🍛" },
    { label: "Tom yum soup", price: "$16.00", glyph: "🥣" },
  ],
  "Slice House": [
    { label: "Margherita pizza", price: "$19.00", glyph: "🍕" },
    { label: "Pepperoni pizza", price: "$21.00", glyph: "🍕" },
    { label: "Garden salad", price: "$11.50", glyph: "🥗" },
  ],
  Sakura: [
    { label: "Salmon rolls", price: "$18.40", glyph: "🍣" },
    { label: "Chicken teriyaki", price: "$20.00", glyph: "🍱" },
    { label: "Miso soup", price: "$6.50", glyph: "🥣" },
  ],
  "Green Bowl": [
    { label: "Soft lentil soup", price: "$12.00", glyph: "🥣" },
    { label: "Smoothie bowl", price: "$13.50", glyph: "🥤" },
    { label: "Mashed potato bowl", price: "$14.00", glyph: "🥔" },
  ],
};

const food: FlowDef = {
  id: "food",
  title: "Food",
  icon: "food",
  surface: "food",
  usualPath: "food",
  start: "kind",
  screens: {
    kind: {
      id: "kind",
      prompt: "What would you like to eat?",
      options: [
        {
          id: "thai",
          label: "Thai",
          sub: "Thai Basil",
          glyph: "🍜",
          set: { restaurant: "Thai Basil" },
          next: "dish",
        },
        {
          id: "pizza",
          label: "Pizza",
          sub: "Slice House",
          glyph: "🍕",
          set: { restaurant: "Slice House" },
          next: "dish",
        },
        {
          id: "sushi",
          label: "Japanese",
          sub: "Sakura",
          glyph: "🍣",
          set: { restaurant: "Sakura" },
          next: "dish",
        },
        {
          id: "soft",
          label: "Soft foods",
          sub: "Green Bowl",
          glyph: "🥣",
          set: { restaurant: "Green Bowl" },
          next: "dish",
        },
      ],
    },
    dish: {
      id: "dish",
      prompt: (s) => `What from ${s.restaurant ?? "there"}?`,
      options: (s) =>
        (MENUS[s.restaurant ?? ""] ?? MENUS["Thai Basil"]!).map((d, i): FlowOption => ({
          id: `d${i}`,
          label: d.label,
          sub: d.price,
          glyph: d.glyph,
          set: { dish: d.label, price: d.price },
          next: "when",
        })),
    },
    when: {
      id: "when",
      prompt: "When should it come?",
      options: [
        {
          id: "asap",
          label: "As soon as possible",
          icon: "clock",
          set: { when: "As soon as possible" },
          end: foodEnd(),
        },
        {
          id: "hour",
          label: "In about an hour",
          icon: "clock",
          set: { when: "In about an hour" },
          end: foodEnd(),
        },
        { id: "seven", label: "At 7 pm", icon: "calendar", set: { when: "At 7 pm" }, end: foodEnd() },
      ],
    },
  },
};

function foodEnd() {
  return {
    type: "task" as const,
    goal: (s: Selections) =>
      `Order ${s.dish ?? "dinner"} from ${s.restaurant ?? "a restaurant"}, ${s.when?.toLowerCase() ?? ""}`.trim(),
    selections: { kind: "food" },
  };
}

// ---- Call someone -----------------------------------------------------------------------------------------------

const PEOPLE: FlowOption[] = [
  { id: "jordan", label: "Jordan", sub: "Caregiver", glyph: "🧑", set: { person: "Jordan" }, next: "why" },
  { id: "morgan", label: "Morgan", sub: "Neighbour", glyph: "🧓", set: { person: "Morgan" }, next: "why" },
  { id: "mom", label: "Mom", sub: "Family", glyph: "👩", set: { person: "Mom" }, next: "why" },
  {
    id: "clinic",
    label: "Dr. Patel's office",
    sub: "Clinic",
    glyph: "🩺",
    set: { person: "Dr. Patel's office" },
    next: "why",
  },
];

const call: FlowDef = {
  id: "call",
  title: "Call someone",
  icon: "phone",
  surface: "call",
  usualPath: "call",
  start: "who",
  screens: {
    who: {
      id: "who",
      prompt: "Who do you want to call?",
      help: "You talk by choosing what to say. They hear a synthetic voice, and AGENCY tells them so.",
      options: PEOPLE,
    },
    why: {
      id: "why",
      prompt: (s) => `What is the call to ${s.person ?? "them"} about?`,
      options: [
        {
          id: "chat",
          label: "Just to talk",
          icon: "message",
          set: { reason: "Just to talk" },
          end: callEnd(),
        },
        {
          id: "help",
          label: "I need help with something",
          icon: "hand",
          set: { reason: "I need help" },
          end: callEnd(),
        },
        {
          id: "appt",
          label: "An appointment",
          icon: "calendar",
          set: { reason: "An appointment" },
          end: callEnd(),
        },
        {
          id: "refill",
          label: "A prescription refill",
          icon: "document",
          set: { reason: "A prescription refill" },
          end: callEnd(),
        },
      ],
    },
  },
};

function callEnd() {
  return {
    type: "pack" as const,
    pack: "call",
    goal: (s: Selections) => `Call ${s.person ?? "someone"} about: ${(s.reason ?? "a chat").toLowerCase()}`,
    selections: { kind: "call" },
  };
}

// ---- Papers -----------------------------------------------------------------------------------------------------

const DOCS = [
  { id: "benefits", label: "Letter from the benefits office", glyph: "✉️", to: "Benefits office" },
  { id: "paratransit", label: "Paratransit renewal form", glyph: "🚐", to: "City paratransit" },
  { id: "lease", label: "Lease renewal", glyph: "🏠", to: "Landlord" },
  { id: "pharmacy", label: "Pharmacy prior authorization", glyph: "💊", to: "Pharmacy" },
];

const papers: FlowDef = {
  id: "papers",
  title: "Papers",
  icon: "document",
  surface: "papers",
  start: "what",
  screens: {
    what: {
      id: "what",
      prompt: "What do you need to do?",
      options: [
        {
          id: "explain",
          label: "Explain a letter",
          sub: "In plain words",
          icon: "info",
          set: { action: "explain" },
          next: "which",
        },
        {
          id: "fill",
          label: "Fill in a form",
          sub: "You check before it's sent",
          icon: "edit",
          set: { action: "fill" },
          next: "which",
        },
        {
          id: "sign",
          label: "Sign a document",
          sub: "With a deliberate confirmation",
          icon: "check",
          set: { action: "sign" },
          next: "which",
        },
        {
          id: "errands",
          label: "Errands and cases",
          sub: "Repairs, rides, appointments",
          icon: "wrench",
          end: { type: "route", path: "/errands" },
        },
      ],
    },
    which: {
      id: "which",
      prompt: "Which one?",
      options: DOCS.map((d): FlowOption => ({
        id: d.id,
        label: d.label,
        glyph: d.glyph,
        set: { document: d.label, to: d.to },
        end: {
          type: "pack",
          pack: "documents",
          goal: (s) =>
            `${s.action === "explain" ? "Explain" : s.action === "sign" ? "Sign" : "Fill in"} the ${d.label.toLowerCase()}`,
          selections: { kind: "papers" },
        },
      })),
    },
  },
};

// ---- Shopping and choosing ----------------------------------------------------------------------------------

const PRODUCTS: Record<
  string,
  {
    label: string;
    glyph: string;
    offers: { store: string; price: string; arrives: string; rating: string }[];
  }[]
> = {
  household: [
    {
      label: "Paper towels",
      glyph: "🧻",
      offers: [
        { store: "Corner Market", price: "$12.99", arrives: "Today", rating: "4.6" },
        { store: "BigBox", price: "$9.49", arrives: "In 2 days", rating: "4.4" },
        { store: "Green Goods", price: "$14.20", arrives: "Tomorrow", rating: "4.8" },
      ],
    },
    {
      label: "Dish soap",
      glyph: "🧴",
      offers: [
        { store: "Corner Market", price: "$4.29", arrives: "Today", rating: "4.5" },
        { store: "BigBox", price: "$3.10", arrives: "In 2 days", rating: "4.3" },
      ],
    },
  ],
  care: [
    {
      label: "Lip balm",
      glyph: "💄",
      offers: [
        { store: "Pharmacy Plus", price: "$3.99", arrives: "Today", rating: "4.7" },
        { store: "BigBox", price: "$2.49", arrives: "In 2 days", rating: "4.2" },
      ],
    },
    {
      label: "Eye drops",
      glyph: "💧",
      offers: [
        { store: "Pharmacy Plus", price: "$8.99", arrives: "Today", rating: "4.8" },
        { store: "BigBox", price: "$7.25", arrives: "In 2 days", rating: "4.5" },
      ],
    },
  ],
  medical: [
    {
      label: "Suction catheters",
      glyph: "🩺",
      offers: [
        { store: "CareSupply", price: "$24.00", arrives: "Tomorrow", rating: "4.9" },
        { store: "MedDirect", price: "$21.50", arrives: "In 3 days", rating: "4.6" },
      ],
    },
    {
      label: "Mask cushions",
      glyph: "😷",
      offers: [
        { store: "CareSupply", price: "$38.00", arrives: "Tomorrow", rating: "4.7" },
        { store: "MedDirect", price: "$35.00", arrives: "In 3 days", rating: "4.4" },
      ],
    },
  ],
};

const shopping: FlowDef = {
  id: "shopping",
  title: "Shopping",
  icon: "bag",
  surface: "shopping",
  start: "category",
  screens: {
    category: {
      id: "category",
      prompt: "What do you need?",
      options: [
        {
          id: "household",
          label: "Household",
          sub: "Paper towels, soap",
          glyph: "🏠",
          set: { category: "household" },
          next: "item",
        },
        {
          id: "care",
          label: "Personal care",
          sub: "Lip balm, eye drops",
          glyph: "🧴",
          set: { category: "care" },
          next: "item",
        },
        {
          id: "medical",
          label: "Medical supplies",
          sub: "Catheters, mask parts",
          glyph: "🩺",
          set: { category: "medical" },
          next: "item",
        },
      ],
    },
    item: {
      id: "item",
      prompt: "Which one?",
      options: (s) =>
        (PRODUCTS[s.category ?? ""] ?? PRODUCTS.household!).map((p, i): FlowOption => ({
          id: `p${i}`,
          label: p.label,
          glyph: p.glyph,
          set: { product: p.label },
          next: "compare",
        })),
    },
    compare: {
      id: "compare",
      prompt: (s) => `Where to buy ${s.product?.toLowerCase() ?? "it"}?`,
      help: "Prices from the sandbox stores. You approve the exact total before anything is paid.",
      layout: "compare",
      options: (s) => {
        const product =
          Object.values(PRODUCTS)
            .flat()
            .find((p) => p.label === s.product) ?? PRODUCTS.household![0]!;
        return product.offers.map((o, i): FlowOption => ({
          id: `o${i}`,
          label: o.store,
          facts: [
            { label: "Price", value: o.price },
            { label: "Arrives", value: o.arrives },
            { label: "Rating", value: `${o.rating} of 5` },
          ],
          set: { store: o.store, price: o.price },
          end: {
            type: "task",
            goal: (sel) => `Buy ${sel.product ?? "it"} from ${o.store} for ${o.price}`,
            selections: { kind: "shopping" },
          },
        }));
      },
    },
  },
};

// ---- Messages ---------------------------------------------------------------------------------------------------

const messages: FlowDef = {
  id: "messages",
  title: "Messages",
  icon: "message",
  surface: "talk",
  start: "who",
  screens: {
    who: {
      id: "who",
      prompt: "Who is it for?",
      options: [
        ...PEOPLE.slice(0, 3).map((p) => ({ ...p, next: "say" })),
        {
          id: "family",
          label: "Family group",
          sub: "4 people",
          glyph: "👪",
          set: { person: "Family group" },
          next: "say",
        },
      ],
    },
    say: {
      id: "say",
      prompt: (s) => `What do you want to tell ${s.person ?? "them"}?`,
      options: ["I'm OK, no need to come", "Can you come by today?", "Please call me", "Thank you!"].map(
        (text, i): FlowOption => ({
          id: `m${i}`,
          label: text,
          icon: "message",
          set: { text },
          end: messageEnd(),
        }),
      ),
      text: {
        key: "text",
        label: "Write my own",
        placeholder: "Your message",
        maxLength: 300,
        end: messageEnd(),
      },
    },
  },
};

function messageEnd() {
  return {
    type: "task" as const,
    goal: (s: Selections) => `Send ${s.person ?? "them"} a message: "${s.text ?? ""}"`,
    selections: { kind: "message", app: "Messages" },
  };
}

// ---- Watch & listen ---------------------------------------------------------------------------------------------

const watch: FlowDef = {
  id: "watch",
  title: "Watch & listen",
  icon: "play",
  surface: "home",
  usualPath: "watch",
  start: "where",
  screens: {
    where: {
      id: "where",
      prompt: "What would you like?",
      options: [
        {
          id: "youtube",
          label: "YouTube",
          sub: "In Chrome",
          glyph: "▶️",
          set: { where: "YouTube in Chrome" },
          next: "youtube",
        },
        {
          id: "netflix",
          label: "Netflix",
          sub: "In Chrome",
          glyph: "🎬",
          set: { where: "Netflix in Chrome" },
          next: "netflix",
        },
        {
          id: "music",
          label: "Music",
          sub: "The Music app",
          glyph: "🎵",
          set: { where: "Music", app: "Music" },
          next: "music",
        },
        {
          id: "tv",
          label: "TV",
          sub: "The TV app",
          glyph: "📺",
          end: { type: "launch", bundleId: "com.apple.TV", name: "TV" },
        },
      ],
    },
    youtube: {
      id: "youtube",
      prompt: "On YouTube:",
      options: [
        {
          id: "continue",
          label: "Continue watching",
          icon: "play",
          end: browseEnd("Open YouTube in Chrome and continue my last video"),
        },
        {
          id: "subs",
          label: "My subscriptions",
          icon: "list",
          end: browseEnd("Open my YouTube subscriptions in Chrome"),
        },
        {
          id: "calm",
          label: "Something calm",
          icon: "sparkle",
          end: browseEnd("Find a calm nature video on YouTube in Chrome"),
        },
      ],
      text: {
        key: "search",
        label: "Search",
        placeholder: "What to search for",
        maxLength: 80,
        end: browseEnd((s) => `Search YouTube for "${s.search ?? ""}" in Chrome`),
      },
    },
    netflix: {
      id: "netflix",
      prompt: "On Netflix:",
      help: "If Netflix asks you to sign in, AGENCY hands it to you or your helper: it never types passwords.",
      options: [
        {
          id: "continue",
          label: "Continue watching",
          icon: "play",
          end: browseEnd("Open Netflix in Chrome and continue watching"),
        },
        { id: "list", label: "My list", icon: "list", end: browseEnd("Open my list on Netflix in Chrome") },
      ],
    },
    music: {
      id: "music",
      prompt: "In Music:",
      options: [
        {
          id: "morning",
          label: "Morning playlist",
          icon: "play",
          set: { playlist: "Morning playlist" },
          end: musicEnd(),
        },
        {
          id: "calm",
          label: "Calm music",
          icon: "sparkle",
          set: { playlist: "Calm music" },
          end: musicEnd(),
        },
        {
          id: "open",
          label: "Just open Music",
          icon: "play",
          end: { type: "launch", bundleId: "com.apple.Music", name: "Music" },
        },
      ],
    },
  },
};

function browseEnd(goal: string | ((s: Selections) => string)) {
  return { type: "task" as const, goal, selections: { kind: "watch" } };
}

function musicEnd() {
  return {
    type: "task" as const,
    goal: (s: Selections) => `Play ${s.playlist ?? "music"} in the Music app`,
    selections: { kind: "watch", app: "Music" },
  };
}

// ---- Browse -----------------------------------------------------------------------------------------------------

const browse: FlowDef = {
  id: "browse",
  title: "Browse",
  icon: "globe",
  surface: "browse",
  start: "where",
  screens: {
    where: {
      id: "where",
      prompt: "Where to?",
      help: "Opens in Chrome. Your eyes work on the page: look at a link to open it.",
      options: [
        {
          id: "news",
          label: "News",
          glyph: "📰",
          set: { where: "the news" },
          end: siteEnd("Open the news in Chrome"),
        },
        {
          id: "weather",
          label: "Weather",
          glyph: "⛅",
          set: { where: "the weather" },
          end: siteEnd("Show today's weather in Chrome"),
        },
        {
          id: "wiki",
          label: "Wikipedia",
          glyph: "📚",
          set: { where: "Wikipedia" },
          end: siteEnd("Open Wikipedia in Chrome"),
        },
        {
          id: "mail",
          label: "My email",
          glyph: "📧",
          set: { where: "your email" },
          end: siteEnd("Open my email in Chrome"),
        },
      ],
      text: {
        key: "search",
        label: "Search the web",
        placeholder: "What to look for",
        maxLength: 120,
        end: siteEnd((s) => `Search the web for "${s.search ?? ""}" in Chrome`),
      },
    },
  },
};

function siteEnd(goal: string | ((s: Selections) => string)) {
  return { type: "task" as const, goal, selections: { kind: "browse", where: "Chrome" } };
}

// ---- Apps -------------------------------------------------------------------------------------------------------

const appsFlow: FlowDef = {
  id: "apps",
  title: "Apps",
  icon: "grid",
  surface: "apps",
  start: "what",
  screens: {
    what: {
      id: "what",
      prompt: "Which app?",
      options: [
        {
          id: "running",
          label: "Switch to an open app",
          icon: "refresh",
          end: { type: "route", path: "/apps?view=running" },
        },
        {
          id: "chrome",
          label: "Chrome",
          glyph: "🌐",
          end: { type: "launch", bundleId: "com.google.Chrome", name: "Google Chrome" },
        },
        {
          id: "mail",
          label: "Mail",
          glyph: "📧",
          end: { type: "launch", bundleId: "com.apple.mail", name: "Mail" },
        },
        {
          id: "photos",
          label: "Photos",
          glyph: "🖼️",
          end: { type: "launch", bundleId: "com.apple.Photos", name: "Photos" },
        },
        { id: "all", label: "All apps", icon: "grid", end: { type: "route", path: "/apps?view=all" } },
      ],
    },
  },
};

export const FLOWS: Record<string, FlowDef> = {
  food,
  call,
  papers,
  shopping,
  messages,
  watch,
  browse,
  apps: appsFlow,
};

/** Selections that exercise every branch of the dynamic screens, for validation. */
export const VALIDATION_SAMPLES: Selections[] = [
  {},
  ...Object.keys(MENUS).map((restaurant) => ({ restaurant })),
  ...Object.entries(PRODUCTS).flatMap(([category, items]) =>
    items.map((p) => ({ category, product: p.label })),
  ),
];
