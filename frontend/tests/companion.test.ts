import { describe, expect, it } from "vitest";
import {
  applyChange,
  BOARDS_KEY,
  CARERS_BOARD,
  DETAILS_KEY,
  readBoards,
  readSnapshot,
  withCarersPhrases,
  type KeyValueStore,
  type MacParts,
} from "../src/companion/apply";
import type { CompanionChange } from "../src/companion/macApi";
import { codeFromHash, contactId } from "../src/companion/phone/phoneApi";
import { STARTER_BOARDS } from "../../os/tasks/src/index";
import type { Favourite } from "../../os/contracts/src/browser";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

function change(kind: CompanionChange["kind"], payload: Record<string, unknown>): CompanionChange {
  return {
    id: 1,
    device_id: "dev_1",
    author: "Jordan",
    kind,
    summary: "",
    status: "waiting_mac",
    reason: null,
    created_at: "2026-10-12T10:00:00Z",
    settled_at: null,
    payload,
  };
}

function parts(over: Partial<MacParts> = {}): MacParts & { favs: Favourite[]; chosen: string[] } {
  const favs: Favourite[] = [];
  const chosen: string[] = [];
  return {
    favs,
    chosen,
    storage: memoryStore(),
    browser: {
      favourites: async () => [...favs],
      setFavourites: async (f) => {
        favs.splice(0, favs.length, ...f);
        return favs;
      },
    },
    papers: {
      chooseFolder: async (c) => {
        chosen.push(c);
        return { display: c === "downloads" ? "~/Downloads" : "~/Documents/AGENCY Papers" };
      },
    },
    folder: () => null,
    ...over,
  };
}

describe("carers' phrases", () => {
  it("adds a carers' board and keeps the person's own boards", () => {
    const boards = withCarersPhrases(STARTER_BOARDS, ["Please turn me"]);
    expect(boards.slice(0, STARTER_BOARDS.length)).toEqual(STARTER_BOARDS);
    expect(boards.at(-1)).toEqual({
      id: CARERS_BOARD,
      title: "From your carers",
      phrases: ["Please turn me"],
    });
  });

  it("replaces the carers' board in place and removes it when empty", () => {
    const once = withCarersPhrases(STARTER_BOARDS, ["A"]);
    const twice = withCarersPhrases(once, ["B", "C"]);
    expect(twice.length).toBe(once.length);
    expect(twice.find((b) => b.id === CARERS_BOARD)?.phrases).toEqual(["B", "C"]);
    expect(withCarersPhrases(twice, []).some((b) => b.id === CARERS_BOARD)).toBe(false);
  });

  it("writes Talk's own storage key", async () => {
    const mac = parts();
    const r = await applyChange(change("phrases", { phrases: ["Water please"] }), mac);
    expect(r.ok).toBe(true);
    const boards = readBoards(mac.storage);
    expect(boards.find((b) => b.id === CARERS_BOARD)?.phrases).toEqual(["Water please"]);
    expect(JSON.parse((mac.storage as ReturnType<typeof memoryStore>).data[BOARDS_KEY]!)).toEqual(boards);
  });

  it("survives broken stored boards", () => {
    expect(readBoards(memoryStore({ [BOARDS_KEY]: "{not json" }))).toEqual(STARTER_BOARDS);
    expect(readBoards(memoryStore({ [BOARDS_KEY]: '{"a":1}' }))).toEqual(STARTER_BOARDS);
  });
});

describe("details for forms", () => {
  it("are saved the way Papers reads them", async () => {
    const mac = parts();
    await applyChange(
      change("details", { details: { fullName: " Riley Example ", city: "Santa Cruz", line1: "1 Main St" } }),
      mac,
    );
    const saved = JSON.parse((mac.storage as ReturnType<typeof memoryStore>).data[DETAILS_KEY]!);
    expect(saved.fullName).toBe("Riley Example");
    expect(saved.preferredName).toBe("Riley");
    expect(saved.address.city).toBe("Santa Cruz");
  });

  it("all empty forgets them", async () => {
    const mac = parts({ storage: memoryStore({ [DETAILS_KEY]: '{"fullName":"x"}' }) });
    await applyChange(change("details", { details: {} }), mac);
    expect((mac.storage as ReturnType<typeof memoryStore>).data[DETAILS_KEY]).toBeUndefined();
  });
});

describe("favourite sites and the Papers folder", () => {
  it("go to the Mac app", async () => {
    const mac = parts();
    expect(
      (
        await applyChange(
          change("favourites", { favourites: [{ title: "BBC", url: "https://bbc.co.uk" }] }),
          mac,
        )
      ).ok,
    ).toBe(true);
    expect(mac.favs.map((f) => f.url)).toEqual(["https://bbc.co.uk"]);
    expect((await applyChange(change("papers_folder", { folder: "downloads" }), mac)).ok).toBe(true);
    expect(mac.chosen).toEqual(["downloads"]);
  });

  it("report honestly when there is no Mac app", async () => {
    const mac = parts({ browser: null, papers: null });
    const fav = await applyChange(change("favourites", { favourites: [] }), mac);
    expect(fav).toEqual({ ok: false, reason: expect.stringContaining("Mac app") });
    const folder = await applyChange(change("papers_folder", { folder: "papers" }), mac);
    expect(folder.ok).toBe(false);
  });

  it("report a failure from the Mac app", async () => {
    const mac = parts({
      papers: {
        chooseFolder: async () => {
          throw new Error("No permission for that folder.");
        },
      },
    });
    expect(await applyChange(change("papers_folder", { folder: "papers" }), mac)).toEqual({
      ok: false,
      reason: "No permission for that folder.",
    });
  });

  it("never applies a change kept on the coordinator", async () => {
    expect((await applyChange(change("contacts", { contacts: [] }), parts())).ok).toBe(false);
  });
});

describe("what the Mac shares with phones", () => {
  it("is the carers' phrases, sites, folder and details", async () => {
    const mac = parts({ folder: () => ({ display: "~/Downloads" }) });
    await applyChange(change("phrases", { phrases: ["Hello"] }), mac);
    await applyChange(
      change("favourites", { favourites: [{ title: "BBC", url: "https://bbc.co.uk" }] }),
      mac,
    );
    await applyChange(change("details", { details: { fullName: "Riley Example" } }), mac);
    const snap = await readSnapshot(mac);
    expect(snap.phrases).toEqual(["Hello"]);
    expect(snap.favourites).toEqual([{ title: "BBC", url: "https://bbc.co.uk" }]);
    expect(snap.papers_folder).toEqual({ display: "~/Downloads" });
    expect(snap.details?.fullName).toBe("Riley Example");
  });

  it("works with nothing saved and no Mac app", async () => {
    const snap = await readSnapshot(parts({ browser: null, papers: null }));
    expect(snap).toEqual({ phrases: [], favourites: [], papers_folder: null, details: null });
  });
});

describe("phone helpers", () => {
  it("reads a pairing code from the link", () => {
    expect(codeFromHash("#pair=012345")).toBe("012345");
    expect(codeFromHash("#/home&pair=999999")).toBe("999999");
    expect(codeFromHash("#pair=12345")).toBeNull();
    expect(codeFromHash("#pair=1234567")).toBeNull();
    expect(codeFromHash("")).toBeNull();
  });

  it("makes valid, unique contact ids", () => {
    const pattern = /^[a-z0-9_]{2,40}$/;
    expect(contactId("Sam O'Neil", [])).toBe("sam_o_neil");
    expect(contactId("Sam", ["sam"])).toBe("sam_2");
    expect(contactId("Zoë", [])).toMatch(pattern);
    expect(contactId("李", [])).toMatch(pattern);
    expect(contactId("A", [])).toMatch(pattern);
    expect(contactId("x".repeat(80), [])).toMatch(pattern);
  });
});
