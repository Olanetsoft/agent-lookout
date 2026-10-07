import { describe, expect, test } from "vitest";

import {
  idleShown,
  notWholeDays,
  quietNowLine,
  readClock,
  readIdleHours,
  readMinutes,
  readRepeatMinutes,
  REPEAT_TAKE,
  repeatShown,
  withDay,
  withRepeat,
} from "@dashboard/lib/time-rules/timeRulesFields";

describe("the minutes of the reminder", () => {
  test.each([
    ["10", 10],
    [" 1 ", 1],
    ["1440", 1440],
  ])("%j is %i", (typed, minutes) => {
    expect(readMinutes(typed)).toBe(minutes);
  });

  test.each(["0", "1441", "2.5", "-3", "ten", "", "1e3"])("%j cannot be taken", (typed) => {
    expect(readMinutes(typed)).toBeNull();
  });
});

describe("the minutes between reminders", () => {
  test.each([
    ["30", 30],
    [" 5 ", 5],
    ["1440", 1440],
  ])("%j is %i", (typed, minutes) => {
    expect(readRepeatMinutes(typed)).toBe(minutes);
  });

  test.each(["4", "0", "1441", "7.5", "half an hour", ""])("%j cannot be taken", (typed) => {
    expect(readRepeatMinutes(typed)).toBeNull();
  });

  test("the line says what the field takes", () => {
    expect(REPEAT_TAKE).toBe("Type a whole number of minutes from 5 to 1440.");
  });

  test("a rule with no repeat, as from before there was one, shows it off, every 30 minutes", () => {
    expect(repeatShown({ on: true, minutes: 10 })).toEqual({ on: false, minutes: 30 });
    expect(repeatShown({ on: true, minutes: 10, repeat: { on: true, minutes: 45 } })).toEqual({
      on: true,
      minutes: 45,
    });
  });

  test("switching it keeps its minutes, and setting them keeps the switch", () => {
    expect(withRepeat({ on: true, minutes: 10 }, { on: true })).toEqual({
      on: true,
      minutes: 10,
      repeat: { on: true, minutes: 30 },
    });
    const set = { on: true, minutes: 10, repeat: { on: true, minutes: 45 } };
    expect(withRepeat(set, { on: false })).toEqual({ ...set, repeat: { on: false, minutes: 45 } });
    expect(withRepeat(set, { minutes: 60 })).toEqual({ ...set, repeat: { on: true, minutes: 60 } });
  });
});

describe("the idle rule's hours", () => {
  test("whole days are shown in days, anything else in hours", () => {
    expect(idleShown(48)).toEqual({ value: 2, unit: "days" });
    expect(idleShown(24)).toEqual({ value: 1, unit: "days" });
    expect(idleShown(36)).toEqual({ value: 36, unit: "hours" });
    expect(idleShown(1)).toEqual({ value: 1, unit: "hours" });
  });

  test("what is typed is read in the unit chosen, an hour to 30 days", () => {
    expect(readIdleHours("3", "days")).toBe(72);
    expect(readIdleHours("30", "days")).toBe(720);
    expect(readIdleHours("31", "days")).toBeNull();
    expect(readIdleHours("0", "days")).toBeNull();
    expect(readIdleHours("1", "hours")).toBe(1);
    expect(readIdleHours("720", "hours")).toBe(720);
    expect(readIdleHours("721", "hours")).toBeNull();
  });

  test("hours that are not whole days are said so, never rounded", () => {
    expect(notWholeDays(36)).toBe("36 hours is not a whole number of days.");
    expect(notWholeDays(1)).toBe("1 hour is not a whole number of days.");
  });
});

describe("while quiet hours hold", () => {
  test("the line says until when, and what is held", () => {
    expect(quietNowLine("08:00")).toBe(
      "Quiet now, until 08:00. Notifications, emails, posts and pushes are held.",
    );
  });
});

describe("a time of quiet hours", () => {
  test.each([
    ["22:00", "22:00"],
    ["8:00", "08:00"],
    ["8", "08:00"],
    ["08", "08:00"],
    ["0830", "08:30"],
    ["830", "08:30"],
    [" 23:59 ", "23:59"],
    ["0", "00:00"],
  ])("%j is %s", (typed, clock) => {
    expect(readClock(typed)).toBe(clock);
  });

  test.each(["24:00", "12:60", "8pm", "", "10:5", "1:2:3"])("%j cannot be taken", (typed) => {
    expect(readClock(typed)).toBeNull();
  });
});

test("a day ticked or unticked keeps the order of the week", () => {
  expect(withDay(["fri", "mon"], "wed", true)).toEqual(["mon", "wed", "fri"]);
  expect(withDay(["mon", "wed", "fri"], "wed", false)).toEqual(["mon", "fri"]);
  expect(withDay([], "sun", true)).toEqual(["sun"]);
});
