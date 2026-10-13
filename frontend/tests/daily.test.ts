/**
 * My day's rules: today's order and what's next, routines that ask only when due and never while put off, the words
 * read aloud, the practice day (and its practice carer), the practice home's prepare-then-run rule, and the
 * Calendar's events as read-only items.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarItems, readCalendar } from "../src/daily/calendar";
import {
  agenda,
  dayKey,
  daySummary,
  dueRoutines,
  everyText,
  formatTime,
  isDue,
  laterTime,
  nextDue,
  occursOn,
  routinePrompt,
} from "../src/daily/day";
import { PracticeHome } from "../src/daily/home";
import { PRACTICE_REPLY_MS, PracticeDaily, practiceDay } from "../src/daily/source";
import { HELP_REQUESTS, readTell, tellPath } from "../src/daily/tell";
import type { Routine, ScheduleItem } from "../src/daily/types";

// Monday 12 October 2026, 2:05 pm local time.
const NOW = new Date(2026, 9, 12, 14, 5, 0);
const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m, 0);

const item = (over: Partial<ScheduleItem>): ScheduleItem => ({
  id: "x",
  kind: "reminder",
  title: "Thing",
  time: "10:00",
  date: null,
  days: [],
  note: "",
  set_by: "carer",
  ...over,
});

const WATER: Routine = {
  id: "water",
  kind: "water",
  title: "Drink some water",
  every_min: 90,
  start: "08:00",
  end: "21:00",
  enabled: true,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("times and days", () => {
  it("formats times and dates plainly", () => {
    expect(formatTime("15:00")).toBe("3:00 pm");
    expect(formatTime("00:30")).toBe("12:30 am");
    expect(formatTime("12:05")).toBe("12:05 pm");
    expect(dayKey(NOW)).toBe("2026-10-12");
    expect(laterTime(NOW, 30)).toBe("14:35");
    expect(laterTime(at(23, 50), 30)).toBe("23:59");
    expect(everyText(120)).toBe("every 2 hours");
    expect(everyText(60)).toBe("every hour");
    expect(everyText(90)).toBe("every 90 minutes");
  });

  it("knows which items are on today", () => {
    expect(occursOn(item({ date: "2026-10-12" }), NOW)).toBe(true);
    expect(occursOn(item({ date: "2026-10-13" }), NOW)).toBe(false);
    expect(occursOn(item({}), NOW)).toBe(true); // every day
    expect(occursOn(item({ days: [0, 2] }), NOW)).toBe(true); // Monday is 0
    expect(occursOn(item({ days: [1] }), NOW)).toBe(false);
  });
});

describe("today's agenda", () => {
  const items = [
    item({ id: "drops", title: "Eye drops", time: "08:30" }),
    item({ id: "physio", title: "Physio visit", time: "15:00", note: "with Sam" }),
    item({ id: "mom", title: "Call Mom", time: "18:00" }),
    item({ id: "lunch", title: "Lunch", time: "12:00" }),
    item({ id: "tue", title: "Tuesday only", time: "16:00", days: [1] }),
  ];

  it("orders the day and marks exactly one thing next", () => {
    const a = agenda(items, { drops: { status: "done", until: null, at: "" } }, NOW);
    expect(a.map((e) => [e.item.id, e.status])).toEqual([
      ["drops", "done"],
      ["lunch", "earlier"],
      ["physio", "next"],
      ["mom", "upcoming"],
    ]);
  });

  it("puts something off until later, and brings it back when the time comes", () => {
    const marks = { physio: { status: "later" as const, until: "16:30", at: "" } };
    const a = agenda(items, marks, NOW);
    expect(a.find((e) => e.item.id === "physio")).toMatchObject({ status: "later", at: "16:30" });
    expect(a.find((e) => e.status === "next")!.item.id).toBe("mom");
  });

  it("brings a put-off item back once its later time has passed", () => {
    const marks = { lunch: { status: "later" as const, until: "13:00", at: "" } };
    expect(agenda(items, marks, NOW).find((e) => e.item.id === "lunch")).toMatchObject({
      status: "earlier",
      at: "13:00",
    });
  });

  it("reads the day aloud, the next thing first", () => {
    const a = agenda(items, { drops: { status: "done", until: null, at: "" } }, NOW);
    const words = daySummary(a, [WATER], NOW);
    expect(words).toBe(
      "It's Monday, 2:05 pm. Time to drink some water? Next: Physio visit at 3:00 pm, with Sam. Then: Call Mom at 6:00 pm. One thing is done.",
    );
    expect(daySummary([], [], NOW)).toBe("It's Monday, 2:05 pm. Nothing is planned for today.");
  });
});

describe("routines ask, they don't tell", () => {
  it("is due once the interval has passed since it was last done", () => {
    const done = (h: number, m = 0) => ({ last_done_at: at(h, m).toISOString(), snoozed_until: null });
    expect(isDue(WATER, done(13, 0), NOW)).toBe(false); // 65 minutes ago
    expect(isDue(WATER, done(12, 30), NOW)).toBe(true); // 95 minutes ago
    expect(nextDue(WATER, done(13, 0), NOW)).toEqual(at(14, 30));
  });

  it("never asks outside waking hours, and starts fresh each morning", () => {
    const lastNight = { last_done_at: new Date(2026, 9, 11, 20, 0).toISOString(), snoozed_until: null };
    expect(isDue(WATER, lastNight, at(7, 30))).toBe(false);
    expect(nextDue(WATER, lastNight, at(7, 30))).toEqual(at(8, 0));
    expect(isDue(WATER, lastNight, at(8, 0))).toBe(true);
    expect(isDue(WATER, undefined, at(22, 0))).toBe(false);
    // Due late in the evening: the next one waits for the morning.
    expect(
      nextDue(WATER, { last_done_at: at(20, 0).toISOString(), snoozed_until: null }, at(20, 30)),
    ).toEqual(new Date(2026, 9, 13, 8, 0));
  });

  it("handles a window that runs overnight", () => {
    const night: Routine = { ...WATER, id: "turn", start: "22:00", end: "06:00", every_min: 120 };
    expect(isDue(night, undefined, at(23, 0))).toBe(true);
    expect(isDue(night, undefined, at(12, 0))).toBe(false);
    expect(
      isDue(
        night,
        { last_done_at: at(23, 0).toISOString(), snoozed_until: null },
        new Date(2026, 9, 13, 0, 30),
      ),
    ).toBe(false);
    expect(
      isDue(
        night,
        { last_done_at: at(23, 0).toISOString(), snoozed_until: null },
        new Date(2026, 9, 13, 1, 0),
      ),
    ).toBe(true);
  });

  it("stays quiet while put off, and when paused", () => {
    const snoozed = { last_done_at: at(10).toISOString(), snoozed_until: at(14, 30).toISOString() };
    expect(isDue(WATER, snoozed, NOW)).toBe(false);
    expect(isDue(WATER, snoozed, at(14, 30))).toBe(true);
    expect(isDue({ ...WATER, enabled: false }, undefined, NOW)).toBe(false);
    expect(dueRoutines([WATER, { ...WATER, id: "off", enabled: false }], {}, NOW).map((r) => r.id)).toEqual([
      "water",
    ]);
  });

  it("asks gently", () => {
    expect(routinePrompt(WATER)).toBe("Time to drink some water?");
    expect(routinePrompt({ ...WATER, title: "Eye drops." })).toBe("Time for eye drops?");
    expect(routinePrompt({ ...WATER, title: "Change position" })).toBe("Time to change position?");
  });
});

describe("the practice day", () => {
  it("always has something next and a routine due, and its carer is a practice phone", async () => {
    const day = practiceDay(NOW);
    const a = agenda(day.items, day.marks[dayKey(NOW)] ?? {}, NOW);
    expect(a.some((e) => e.status === "next")).toBe(true);
    expect(dueRoutines(day.routines, day.routine_state, NOW).map((r) => r.id)).toEqual(["water"]);
    const p = new PracticeDaily(() => NOW, false);
    const s = await p.state(dayKey(NOW));
    expect(s.carer).toMatchObject({ name: "Jordan", simulated: true });
    expect(s.carer!.how).toContain("nobody real");
  });

  it("marks, routines and requests stay in the page, and the practice carer answers", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const p = new PracticeDaily(() => now, false);
    await p.mark({ item_id: "physio", day: dayKey(NOW), status: "done" });
    expect((await p.state(dayKey(NOW))).marks.physio!.status).toBe("done");
    await p.mark({ item_id: "physio", day: dayKey(NOW), status: "clear" });
    expect((await p.state(dayKey(NOW))).marks.physio).toBeUndefined();

    await p.routineLater("water", 30);
    let s = await p.state(dayKey(NOW));
    expect(isDue(s.routines[0]!, s.routine_state.water, now)).toBe(false);
    now = new Date(NOW.getTime() + 31 * 60_000);
    expect(isDue(s.routines[0]!, s.routine_state.water, now)).toBe(true);
    await p.routineDone("water");
    s = await p.state(dayKey(NOW));
    expect(isDue(s.routines[0]!, s.routine_state.water, now)).toBe(false);

    const r = await p.request("help", "I'm cold");
    expect(r).toMatchObject({ status: "delivered", simulated: true, carer: { name: "Jordan" }, reply: null });
    vi.advanceTimersByTime(PRACTICE_REPLY_MS);
    expect((await p.requests())[0]).toMatchObject({ reply: "coming", reply_words: "On my way" });
  });

  it("with telling a carer off, nobody is told", async () => {
    const p = new PracticeDaily(() => NOW, false);
    const s = await p.state(dayKey(NOW));
    await p.saveSettings({ ...s.settings, carer_notify: false });
    expect((await p.state(dayKey(NOW))).carer).toBeNull();
    expect(await p.request("help", "I'm cold")).toMatchObject({ status: "shown", carer: null });
  });

  it("never keeps Calendar items", async () => {
    const p = new PracticeDaily(() => NOW, false);
    await p.saveItems([item({ id: "a" }), item({ id: "cal-0", fromCalendar: true })]);
    expect((await p.state(dayKey(NOW))).items.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("the practice home", () => {
  it("changes a device only through a prepared ticket, once", async () => {
    const home = new PracticeHome(() => 1);
    const p = await home.prepare("bedroom-lamp", "on");
    if (!p.ok) throw new Error(p.error);
    expect(p).toMatchObject({ summary: "Turn on: Bedroom lamp", confirm: false });
    expect(await home.run(p.ticket, "wrong")).toMatchObject({ ok: false });
    expect(await home.run(p.ticket, p.fingerprint)).toMatchObject({ ok: false }); // used up
    const again = await home.prepare("bedroom-lamp", "on");
    if (!again.ok) throw new Error(again.error);
    expect(await home.run(again.ticket, again.fingerprint)).toEqual({
      ok: true,
      state: "On",
      summary: "Turn on: Bedroom lamp",
    });
    expect((await home.status()).devices.find((d) => d.id === "bedroom-lamp")!.state).toBe("On");
  });

  it("heating always asks for a confirmation, and Stop forgets what was waiting", async () => {
    const home = new PracticeHome();
    const p = await home.prepare("thermostat", "off");
    expect(p).toMatchObject({ ok: true, confirm: true });
    home.stopAll();
    if (p.ok) expect((await home.run(p.ticket, p.fingerprint)).ok).toBe(false);
  });

  it("has no doors, locks or garages at all", async () => {
    const names = (await new PracticeHome().status()).devices.flatMap((d) => [
      d.name,
      ...d.actions.map((a) => a.label),
    ]);
    expect(names.join(" ")).not.toMatch(/\b(door|lock|unlock|garage|gate)\b/i);
  });
});

describe("telling a carer", () => {
  it("carries the request in the address, checked on the way in", () => {
    const path = tellPath("help", "I'm cold");
    const q = new URLSearchParams(path.split("?")[1]);
    expect(readTell(q)).toEqual({ kind: "help", text: "I'm cold" });
    expect(readTell(new URLSearchParams("kind=alarm&text=x"))).toBeNull();
    expect(readTell(new URLSearchParams("kind=help&text=%20%20"))).toBeNull();
    expect(readTell(new URLSearchParams(`kind=help&text=${"a".repeat(300)}`))!.text).toHaveLength(160);
  });

  it("offers everyday requests, none of them emergencies", () => {
    expect(HELP_REQUESTS.length).toBeLessThanOrEqual(7); // plus Lifeline: at most 8 choices
    expect(HELP_REQUESTS.map((r) => r.text).join(" ")).not.toMatch(/emergency|breath|chok|911|pain/i);
  });
});

describe("the Mac's Calendar", () => {
  it("turns events into read-only items for today", () => {
    const items = calendarItems([
      { title: "Dentist", start: "09:30", allDay: false, location: "Main St", calendar: "Home" },
      { title: "", start: "00:00", allDay: true, location: "", calendar: "Home" },
    ]);
    expect(items[0]).toMatchObject({ title: "Dentist", time: "09:30", note: "Main St", fromCalendar: true });
    expect(items[1]).toMatchObject({ title: "Event", note: "All day" });
  });

  it("says plainly when there is no Mac app, or an older one", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(await readCalendar()).toEqual({
      ok: false,
      error: "The Mac's Calendar needs the AGENCY Mac app.",
    });
    const call = vi.fn().mockRejectedValue(new Error("shell may not call calendar.today"));
    vi.stubGlobal("window", { agency: { agent: { send() {} }, native: { call } } });
    expect(await readCalendar()).toEqual({
      ok: false,
      error: "This version of the AGENCY Mac app can't read the Calendar yet.",
    });
    call.mockResolvedValue({ ok: true, events: [] });
    expect(await readCalendar()).toEqual({ ok: true, events: [] });
    expect(call).toHaveBeenLastCalledWith("calendar.today", {});
  });
});
