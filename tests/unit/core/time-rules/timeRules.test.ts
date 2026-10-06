import { describe, expect, test } from "vitest";

import { STALE_THRESHOLD_MS } from "@core/sessions/staleness";
import {
  clockMinutes,
  DEFAULT_TIME_RULES,
  readTimeRules,
  rulesOf,
  staleAfterMs,
  timeRulesIn,
  type TimeRules,
} from "@core/time-rules/timeRules";

const HOUR = 60 * 60 * 1000;

/** Every rule on, as the card would send them. */
const SET: TimeRules = {
  longWait: { on: true, minutes: 15 },
  idle: { on: true, hours: 72 },
  quietHours: {
    on: true,
    from: "21:30",
    to: "07:00",
    days: ["mon", "tue", "wed", "thu", "fri"],
    leaveOutAnswered: true,
  },
};

describe("the rules before anyone sets them", () => {
  test("every rule is off, with a reminder after 10 minutes, stale after 2 days and quiet from 22:00 to 08:00 every day", () => {
    expect(DEFAULT_TIME_RULES).toEqual({
      longWait: { on: false, minutes: 10 },
      idle: { on: false, hours: 48 },
      quietHours: {
        on: false,
        from: "22:00",
        to: "08:00",
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        leaveOutAnswered: false,
      },
    });
  });

  test("a snapshot from a collector without rules is every rule off", () => {
    expect(rulesOf({})).toEqual(DEFAULT_TIME_RULES);
    expect(rulesOf({ timeRules: SET })).toBe(SET);
  });
});

describe("clockMinutes", () => {
  test.each([
    ["00:00", 0],
    ["08:30", 510],
    ["22:00", 1320],
    ["23:59", 1439],
  ])("%s is %i minutes after midnight", (clock, minutes) => {
    expect(clockMinutes(clock)).toBe(minutes);
  });

  test.each(["24:00", "8:00", "08:60", "0800", " 08:00", "", "noon"])(
    "%j is not a time as the rules write one",
    (clock) => {
      expect(clockMinutes(clock)).toBeNull();
    },
  );
});

describe("staleAfterMs", () => {
  test("while the idle rule is off, a session is stale after the built-in day", () => {
    expect(staleAfterMs(DEFAULT_TIME_RULES)).toBe(STALE_THRESHOLD_MS);
    expect(staleAfterMs(undefined)).toBe(STALE_THRESHOLD_MS);
    expect(staleAfterMs(null)).toBe(STALE_THRESHOLD_MS);
  });

  test("while it is on, after the hours it says, an hour to 30 days", () => {
    expect(staleAfterMs(SET)).toBe(72 * HOUR);
    expect(staleAfterMs({ ...SET, idle: { on: true, hours: 1 } })).toBe(HOUR);
    expect(staleAfterMs({ ...SET, idle: { on: true, hours: 720 } })).toBe(30 * 24 * HOUR);
    expect(staleAfterMs({ ...SET, idle: { on: false, hours: 1 } })).toBe(STALE_THRESHOLD_MS);
  });
});

describe("readTimeRules, as a file or an answer holds them", () => {
  test("rules written whole are read as they are", () => {
    expect(readTimeRules(SET)).toEqual({ rules: SET, unread: [] });
  });

  test("a key that is not one of theirs is passed over, in the rules and in each rule", () => {
    const later = {
      ...SET,
      sleepNudge: { on: true },
      longWait: { ...SET.longWait, sound: "chime" },
    };
    expect(readTimeRules(later)).toEqual({ rules: SET, unread: [] });
  });

  test("a rule that is not there is off, and is not counted as unread", () => {
    expect(readTimeRules({ idle: SET.idle })).toEqual({
      rules: { ...DEFAULT_TIME_RULES, idle: SET.idle },
      unread: [],
    });
    expect(readTimeRules(undefined)).toEqual({ rules: DEFAULT_TIME_RULES, unread: [] });
  });

  test("a rule that cannot be read whole is off, never half read, and is named", () => {
    const read = readTimeRules({
      ...SET,
      longWait: { on: true, minutes: 0 },
      quietHours: { ...SET.quietHours, to: "7am" },
    });
    expect(read.unread).toEqual(["longWait", "quietHours"]);
    expect(read.rules.longWait).toEqual(DEFAULT_TIME_RULES.longWait);
    expect(read.rules.quietHours).toEqual(DEFAULT_TIME_RULES.quietHours);
    expect(read.rules.idle).toEqual(SET.idle);
  });

  test.each<[string, unknown]>([
    ["minutes past the most", { on: true, minutes: 1441 }],
    ["minutes that are not whole", { on: true, minutes: 2.5 }],
    ["minutes as text", { on: true, minutes: "10" }],
    ["a switch that is not true or false", { on: "yes", minutes: 10 }],
    ["no switch", { minutes: 10 }],
  ])("a long wait reminder with %s cannot be read", (_, longWait) => {
    expect(readTimeRules({ longWait }).unread).toEqual(["longWait"]);
  });

  test.each<[string, unknown]>([
    ["no hours", { on: true }],
    ["under an hour", { on: true, hours: 0 }],
    ["past 30 days", { on: true, hours: 721 }],
  ])("an idle rule with %s cannot be read", (_, idle) => {
    expect(readTimeRules({ idle }).unread).toEqual(["idle"]);
  });

  test.each<[string, Partial<TimeRules["quietHours"]>]>([
    ["the same time at both ends", { from: "08:00", to: "08:00" }],
    ["a day that is not one", { days: ["mon", "funday"] as never }],
    ["a day twice", { days: ["mon", "mon"] }],
    ["no switch for the summary", { leaveOutAnswered: undefined }],
  ])("quiet hours with %s cannot be read", (_, change) => {
    expect(readTimeRules({ quietHours: { ...SET.quietHours, ...change } }).unread).toEqual([
      "quietHours",
    ]);
  });

  test("days are put in the order of the week", () => {
    const read = readTimeRules({ quietHours: { ...SET.quietHours, days: ["sun", "mon"] } });
    expect(read.rules.quietHours.days).toEqual(["mon", "sun"]);
  });

  test("something that is not an object at all leaves every rule off, and unread", () => {
    expect(readTimeRules([1, 2])).toEqual({
      rules: DEFAULT_TIME_RULES,
      unread: ["longWait", "idle", "quietHours"],
    });
  });

  test("what it reads is its own: changing it changes no default", () => {
    const { rules } = readTimeRules(undefined);
    rules.quietHours.days.pop();
    rules.longWait.on = true;
    expect(DEFAULT_TIME_RULES.quietHours.days).toHaveLength(7);
    expect(DEFAULT_TIME_RULES.longWait.on).toBe(false);
  });
});

describe("timeRulesIn, as a change asks for them", () => {
  test("the three rules, each whole and right, are taken", () => {
    expect(timeRulesIn(SET)).toEqual({ ok: true, rules: SET });
    expect(timeRulesIn(DEFAULT_TIME_RULES)).toEqual({ ok: true, rules: DEFAULT_TIME_RULES });
  });

  test.each<[string, unknown]>([
    ["nothing", null],
    ["a list", [SET]],
    ["one rule left out", { longWait: SET.longWait, idle: SET.idle }],
    ["a key of another kind", { ...SET, sleepNudge: { on: true } }],
  ])("%s is refused, saying what is wanted", (_, body) => {
    expect(timeRulesIn(body)).toEqual({
      ok: false,
      problem:
        "The body must be the three time rules, longWait, idle and quietHours, and nothing else.",
    });
  });

  test("a rule that says more than its own fields is refused whole, though the rest fits", () => {
    const answer = timeRulesIn({ ...SET, longWait: { ...SET.longWait, sound: "chime" } });
    expect(answer).toEqual({
      ok: false,
      problem: 'longWait must be {"on", "minutes"}, with minutes a whole number from 1 to 1440.',
    });
  });

  test("each rule's sentence says what it must be", () => {
    const idle = timeRulesIn({ ...SET, idle: { on: true, hours: 0 } });
    expect(idle).toEqual({
      ok: false,
      problem: 'idle must be {"on", "hours"}, with hours a whole number from 1 to 720.',
    });
    const quiet = timeRulesIn({ ...SET, quietHours: { ...SET.quietHours, from: "07:00" } });
    expect(quiet.ok).toBe(false);
    expect(!quiet.ok && quiet.problem).toMatch(/^quietHours must be .*two different times/);
  });
});
