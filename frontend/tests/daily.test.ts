/**
 * My day (src/daily): the schedule and its marks, care routines that ask within waking hours and can be snoozed,
 * what Home shows next, the day read aloud, storage that never trusts what it reads, the practice home (never a
 * door, a confirmation look for heating) and telling a carer (off unless on, exact words, once).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  at,
  checkData,
  clock,
  dayKey,
  daySpeech,
  entriesFor,
  every,
  isDue,
  mark,
  newRoutine,
  nextDue,
  nextUp,
  occursOn,
  ordered,
  routineDone,
  routineLater,
  sampleDay,
  unmark,
  type DailyData,
  type DayItem,
} from "../src/daily/model";
import { clearDaily, DAILY_KEY, loadDaily, practiceMode, saveDaily, updateDaily } from "../src/daily/store";
import { homeSource, PRACTICE_SETUP, PracticeHome, resetPracticeHome } from "../src/daily/homeControl";
import { carerSource, coordinatorCarer, PracticeCarer } from "../src/daily/carer";
import { reminderItem, whenChoices } from "../src/daily/RemindMe";
import { cardText } from "../src/daily/DayCard";
import { HELP_REQUESTS } from "../src/daily/parts";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

/** Monday 12 October 2026, local time. */
const MON = (h: number, m = 0) => new Date(2026, 9, 12, h, m).getTime();
const TODAY = "2026-10-12";

const item = (id: string, over: Partial<DayItem> = {}): DayItem => ({
  id,
  title: id,
  kind: "appointment",
  date: TODAY,
  time: "10:00",
  repeat: "once",
  addedBy: "helper",
  ...over,
});

const data = (over: Partial<DailyData> = {}): DailyData => ({ items: [], routines: [], marks: {}, ...over });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPracticeHome();
});

describe("times", () => {
  it("formats plainly, with no locale surprises", () => {
    expect(clock("00:05")).toBe("12:05 am");
    expect(clock("12:00")).toBe("12:00 pm");
    expect(clock("14:30")).toBe("2:30 pm");
    expect(dayKey(MON(23, 59))).toBe(TODAY);
    expect(at(MON(3), "14:30")).toBe(MON(14, 30));
    expect(every(60)).toBe("every hour");
    expect(every(120)).toBe("every 2 hours");
    expect(every(90)).toBe("every 90 minutes");
  });
});

describe("My day", () => {
  it("knows which days an item happens on", () => {
    expect(occursOn(item("a"), TODAY)).toBe(true);
    expect(occursOn(item("a"), "2026-10-13")).toBe(false);
    expect(occursOn(item("a", { repeat: "daily" }), "2026-10-20")).toBe(true);
    expect(occursOn(item("a", { repeat: "daily" }), "2026-10-11")).toBe(false);
    expect(occursOn(item("a", { repeat: "weekdays" }), "2026-10-16")).toBe(true); // Friday
    expect(occursOn(item("a", { repeat: "weekdays" }), "2026-10-17")).toBe(false); // Saturday
    expect(occursOn(item("a", { repeat: "weekly" }), "2026-10-19")).toBe(true);
    expect(occursOn(item("a", { repeat: "weekly" }), "2026-10-20")).toBe(false);
  });

  it("lists the day in time order with any-time items last, and keeps open ones first", () => {
    const d = data({
      items: [item("late", { time: "15:00" }), item("any", { time: null }), item("early", { time: "08:00" })],
    });
    const now = MON(9);
    expect(entriesFor(d, TODAY, now).map((e) => e.item.id)).toEqual(["early", "late", "any"]);
    const early = entriesFor(d, TODAY, now)[0]!;
    const done = mark(d, early, "done", now);
    expect(ordered(entriesFor(done, TODAY, now)).map((e) => [e.item.id, e.state])).toEqual([
      ["late", "open"],
      ["any", "open"],
      ["early", "done"],
    ]);
    expect(entriesFor(unmark(done, early), TODAY, now)[0]!.state).toBe("open");
  });

  it("brings a 'later' back after half an hour, and marks are per day", () => {
    const d = data({ items: [item("x", { repeat: "daily" })] });
    const e = entriesFor(d, TODAY, MON(9))[0]!;
    const later = mark(d, e, "later", MON(9));
    expect(entriesFor(later, TODAY, MON(9, 10))[0]!.state).toBe("later");
    expect(entriesFor(later, TODAY, MON(9, 31))[0]!.state).toBe("open");
    expect(entriesFor(mark(d, e, "done", MON(9)), "2026-10-13", MON(9))[0]!.state).toBe("open");
  });

  it("forgets marks after two weeks", () => {
    const d = data({
      items: [item("x")],
      marks: { "old@2026-09-01": { status: "done", at: MON(9) - 20 * 86_400_000 } },
    });
    const e = entriesFor(d, TODAY, MON(9))[0]!;
    expect(Object.keys(mark(d, e, "done", MON(9)).marks)).toEqual([`x@${TODAY}`]);
  });
});

describe("care routines", () => {
  const r = { ...newRoutine("eye_drops", "drops"), everyMinutes: 240, from: "08:00", to: "22:00" };

  it("asks first at the start of waking hours, then every so often after it was done", () => {
    expect(nextDue(r, MON(6))).toBe(MON(8));
    expect(isDue(r, MON(7, 59))).toBe(false);
    expect(isDue(r, MON(8))).toBe(true);
    const done = { ...r, lastDone: MON(9) };
    expect(nextDue(done, MON(10))).toBe(MON(13));
  });

  it("never asks outside waking hours: tomorrow morning instead", () => {
    const done = { ...r, lastDone: MON(20) };
    expect(nextDue(done, MON(21))).toBe(new Date(2026, 9, 13, 8).getTime());
    expect(isDue({ ...r, lastDone: MON(10) }, MON(22, 30))).toBe(false);
    expect(nextDue({ ...r, lastDone: new Date(2026, 9, 11, 21).getTime() }, MON(6))).toBe(MON(8));
  });

  it("a 'to' before 'from' means until midnight", () => {
    expect(isDue({ ...r, from: "09:00", to: "00:00", lastDone: MON(19) }, MON(23, 30))).toBe(true);
  });

  it("snoozes, and Done clears the snooze", () => {
    const now = MON(12);
    const d = data({ routines: [{ ...r, lastDone: MON(7) }] });
    expect(isDue(d.routines[0]!, now)).toBe(true);
    const snoozed = routineLater(d, "drops", now);
    expect(isDue(snoozed.routines[0]!, now + 10 * 60_000)).toBe(false);
    expect(isDue(snoozed.routines[0]!, now + 31 * 60_000)).toBe(true);
    const done = routineDone(snoozed, "drops", now);
    expect(done.routines[0]).toMatchObject({ lastDone: now, snoozedUntil: null });
  });

  it("is silent when switched off", () => {
    expect(nextDue({ ...r, enabled: false }, MON(12))).toBeNull();
  });
});

describe("what's next and reading the day aloud", () => {
  it("puts a routine that is asking first, then the next open item, then nothing", () => {
    const routine = { ...newRoutine("water", "w"), lastDone: MON(9) };
    const d = data({
      items: [item("past", { time: "08:00" }), item("visit", { time: "14:00" })],
      routines: [routine],
    });
    expect(nextUp(d, MON(12))).toMatchObject({ type: "routine" });
    expect(nextUp(routineDone(d, "w", MON(12)), MON(12))).toMatchObject({
      type: "item",
      entry: { item: { id: "visit" } },
    });
    expect(nextUp(data(), MON(12))).toEqual({ type: "nothing" });
    expect(cardText(nextUp(data(), MON(12))).title).toBe("Nothing else today");
    expect(cardText(nextUp(d, MON(12))).path).toBe("/day/care");
  });

  it("reads the day in plain sentences", () => {
    const d = data({
      items: [item("Physio visit", { time: "11:00" }), item("Call Mom", { time: null })],
      routines: [{ ...newRoutine("reposition", "t"), lastDone: MON(9) }],
    });
    const text = daySpeech(d, MON(10));
    expect(text).toContain("Today is Monday 12 October.");
    expect(text).toContain("At 11:00 am: Physio visit.");
    expect(text).toContain("Any time: Call Mom.");
    expect(text).toContain("Change position: next at 11:00 am.");
    expect(daySpeech(data(), MON(10))).toContain("Nothing is planned today.");
  });
});

describe("checking stored data", () => {
  it("keeps good data and drops anything malformed", () => {
    const good = sampleDay(MON(9));
    expect(checkData(JSON.parse(JSON.stringify(good)))).toEqual(good);
    const bad = checkData({
      items: [
        item("ok"),
        { ...item("bad"), time: "25:00" },
        { ...item("x"), title: "" },
        { ...item("y"), date: "2026-02-31" },
        null,
      ],
      routines: [
        { ...newRoutine("water", "w"), everyMinutes: 1 },
        { ...newRoutine("water", "v"), kind: "medication" },
      ],
      marks: { a: { status: "done", at: 1 }, b: { status: "exploded", at: 1 }, c: "x" },
    });
    expect(bad.items.map((i) => i.id)).toEqual(["ok"]);
    expect(bad.routines).toEqual([]);
    expect(Object.keys(bad.marks)).toEqual(["a"]);
    expect(checkData("nonsense")).toEqual(data());
  });

  it("turns control characters in titles into spaces", () => {
    const d = checkData({ items: [{ ...item("a"), title: "Phy\u0007sio\nvisit" }] });
    expect(d.items[0]!.title).toBe("Phy sio visit");
  });
});

describe("storage", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));

  it("starts empty, outside practice", () => {
    expect(practiceMode()).toBe(false);
    expect(loadDaily()).toEqual(data());
  });

  it("seeds a sample day once in practice, and Clear doesn't bring it back", () => {
    localStorage.setItem("agency.fakes", "daily");
    expect(loadDaily(MON(9)).items.length).toBeGreaterThan(0);
    clearDaily();
    expect(loadDaily(MON(9))).toEqual(data());
  });

  it("saves and updates, and survives broken storage", () => {
    updateDaily((d) => ({ ...d, items: [item("a")] }));
    expect(loadDaily().items.map((i) => i.id)).toEqual(["a"]);
    localStorage.setItem(DAILY_KEY, "{not json");
    expect(loadDaily()).toEqual(data());
    saveDaily(data({ items: [item("b")] }));
    expect(JSON.parse(localStorage.getItem(DAILY_KEY)!).items[0].id).toBe("b");
  });

  it("practice in the web demo too", () => {
    vi.stubEnv("VITE_WEB_DEMO", "1");
    expect(practiceMode()).toBe(true);
  });
});

describe("Remind me", () => {
  it("offers later today and tomorrow, and this evening only while it's to come", () => {
    const morning = whenChoices(MON(9, 2)).map((w) => [w.id, w.date, w.time]);
    expect(morning).toEqual([
      ["30m", TODAY, "09:35"],
      ["1h", TODAY, "10:05"],
      ["2h", TODAY, "11:05"],
      ["evening", TODAY, "18:00"],
      ["tomorrow", "2026-10-13", "09:00"],
    ]);
    expect(whenChoices(MON(19)).map((w) => w.id)).not.toContain("evening");
    expect(whenChoices(MON(23, 50))[0]).toMatchObject({ date: "2026-10-13", time: "00:20" });
    expect(reminderItem("Call someone", whenChoices(MON(9))[0]!, "me-1")).toMatchObject({
      kind: "reminder",
      addedBy: "person",
      repeat: "once",
    });
  });
});

describe("practice home", () => {
  it("changes its pretend devices and remembers what it last set", async () => {
    const home = new PracticeHome(() => 0);
    expect(await home.run("bedroom-light", "on", false)).toEqual({ ok: true, state: "On" });
    expect((await home.status()).states["bedroom-light"]?.state).toBe("On");
  });

  it("needs a confirmation look for heating", async () => {
    const home = new PracticeHome(() => 0);
    expect(await home.run("heating", "off", false)).toMatchObject({ ok: false, error: /confirmation look/ });
    expect(home.ran).toEqual([]);
    expect(await home.run("heating", "off", true)).toEqual({ ok: true, state: "Off" });
  });

  it("refuses a lock or a door in its setup", async () => {
    const home = new PracticeHome(() => 0);
    const door = structuredClone(PRACTICE_SETUP);
    door.devices.push({
      id: "door",
      name: "Front door",
      kind: "other",
      actions: [{ id: "u", label: "Unlock", shortcut: "Unlock" }],
    });
    expect(await home.save(door)).toMatchObject({ ok: false, error: /never controls locks/ });
    expect(PRACTICE_SETUP.devices.some((d) => /door|lock|garage|gate/i.test(d.name))).toBe(false);
  });

  it("is used in the browser, and the Mac's home only inside the Mac app", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("window", {});
    expect(homeSource().kind).toBe("practice");
    const real = {
      status: vi.fn(),
      save: vi.fn(),
      shortcuts: vi.fn(),
      run: vi.fn(async () => ({ ok: true, state: "On" })),
    };
    vi.stubGlobal("window", { agency: { agent: { send: () => {} }, home: real } });
    const mac = homeSource();
    expect(mac.kind).toBe("mac");
    void mac.run("lamp", "on", true);
    expect(real.run).toHaveBeenCalledWith("lamp", "on", true);
    localStorage.setItem("agency.fakes", "home");
    expect(homeSource().kind).toBe("practice");
  });
});

describe("telling a carer", () => {
  it("the practice carer sends exactly the prepared words, once", async () => {
    const c = new PracticeCarer();
    const p = await c.prepare("help", "I'm cold.");
    expect(p.body).toContain("(not urgent): I'm cold.");
    expect(p.to.simulated).toBe(true);
    expect(await c.send(p.ticket)).toMatchObject({ status: "delivered", simulated: true });
    await expect(c.send(p.ticket)).rejects.toThrow(/already sent/);
    expect((await c.messages()).map((m) => m.body)).toEqual([p.body]);
  });

  it("the practice carer can be turned off", async () => {
    const c = new PracticeCarer();
    const p = await c.prepare("help", "Hello");
    await c.save({ notify_enabled: false, carer_id: null });
    await expect(c.prepare("help", "Hello")).rejects.toThrow(/off/);
    await expect(c.send(p.ticket)).rejects.toThrow();
  });

  it("uses the coordinator outside practice, with the access token, and shows its refusal", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    localStorage.setItem("agency.token", "tok");
    expect(carerSource()).toBe(coordinatorCarer);
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ detail: "Telling a carer is off." }), { status: 409 });
      }),
    );
    await expect(coordinatorCarer.prepare("help", "I'm cold")).rejects.toThrow("Telling a carer is off.");
    expect(calls[0]!.url).toMatch(/\/api\/daily\/prepare$/);
    expect(new Headers(calls[0]!.init.headers).get("X-Agency-Token")).toBe("tok");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ kind: "help", text: "I'm cold" });
  });

  it("says nothing was sent when the coordinator can't be reached", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(coordinatorCarer.send("t".repeat(20))).rejects.toThrow(/Nothing was sent/);
  });
});

describe("help requests", () => {
  it("fit one page and are never emergencies", () => {
    expect(HELP_REQUESTS.length).toBeLessThanOrEqual(6);
    for (const h of HELP_REQUESTS) expect(h.words).not.toMatch(/emergenc|911|ambulance|can't breathe/i);
  });
});

describe("storage that can't be used", () => {
  it("keeps the day in memory for this page", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    saveDaily(data({ items: [item("kept")] }));
    expect(loadDaily().items.map((i) => i.id)).toEqual(["kept"]);
  });

  it("doesn't bring back an old day once storage works again", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(loadDaily()).toEqual(data());
  });
});
