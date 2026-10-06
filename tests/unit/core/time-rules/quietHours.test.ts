import { describe, expect, test, vi } from "vitest";

import { isQuietAt, quietOf } from "@core/time-rules/quietHours";
import { DEFAULT_TIME_RULES, type QuietHoursRule, type Weekday } from "@core/time-rules/timeRules";

/** A moment on the local clock in the week of Monday 5 October 2026, far from a change of the clocks. */
function at(day: Weekday, clock: string): number {
  const offsets: Record<Weekday, number> = {
    mon: 0,
    tue: 1,
    wed: 2,
    thu: 3,
    fri: 4,
    sat: 5,
    sun: 6,
  };
  const [hours, minutes] = clock.split(":").map(Number) as [number, number];
  return new Date(2026, 9, 5 + offsets[day], hours, minutes).getTime();
}

function quiet(overrides: Partial<QuietHoursRule> = {}): QuietHoursRule {
  return { ...DEFAULT_TIME_RULES.quietHours, on: true, ...overrides };
}

describe("isQuietAt", () => {
  test("22:00 to 08:00 runs past midnight: quiet from the evening into the next morning", () => {
    const rule = quiet({ from: "22:00", to: "08:00" });
    expect(isQuietAt(rule, at("mon", "21:59"))).toBe(false);
    expect(isQuietAt(rule, at("mon", "22:00"))).toBe(true);
    expect(isQuietAt(rule, at("mon", "23:59"))).toBe(true);
    expect(isQuietAt(rule, at("tue", "00:00"))).toBe(true);
    expect(isQuietAt(rule, at("tue", "07:59"))).toBe(true);
    expect(isQuietAt(rule, at("tue", "08:00"))).toBe(false);
    expect(isQuietAt(rule, at("tue", "12:00"))).toBe(false);
  });

  test("hours within one day are quiet from the first time up to the second", () => {
    const rule = quiet({ from: "12:30", to: "13:15" });
    expect(isQuietAt(rule, at("wed", "12:29"))).toBe(false);
    expect(isQuietAt(rule, at("wed", "12:30"))).toBe(true);
    expect(isQuietAt(rule, at("wed", "13:14"))).toBe(true);
    expect(isQuietAt(rule, at("wed", "13:15"))).toBe(false);
    expect(isQuietAt(rule, at("wed", "23:00"))).toBe(false);
  });

  test("the days are the days quiet hours begin on: weeknights run into Saturday morning, and the weekend's nights are not quiet", () => {
    const rule = quiet({ from: "22:00", to: "08:00", days: ["mon", "tue", "wed", "thu", "fri"] });
    expect(isQuietAt(rule, at("mon", "07:00"))).toBe(false);
    expect(isQuietAt(rule, at("mon", "22:30"))).toBe(true);
    expect(isQuietAt(rule, at("fri", "23:00"))).toBe(true);
    expect(isQuietAt(rule, at("sat", "07:00"))).toBe(true);
    expect(isQuietAt(rule, at("sat", "22:30"))).toBe(false);
    expect(isQuietAt(rule, at("sun", "07:00"))).toBe(false);
    expect(isQuietAt(rule, at("sun", "22:30"))).toBe(false);
  });

  test("hours within one day go by the day itself", () => {
    const rule = quiet({ from: "09:00", to: "17:00", days: ["sat", "sun"] });
    expect(isQuietAt(rule, at("sat", "10:00"))).toBe(true);
    expect(isQuietAt(rule, at("sun", "16:59"))).toBe(true);
    expect(isQuietAt(rule, at("mon", "10:00"))).toBe(false);
  });

  test("with the rule off, or no day ticked, nothing is quiet", () => {
    expect(isQuietAt(quiet({ on: false }), at("mon", "23:00"))).toBe(false);
    expect(isQuietAt(quiet({ days: [] }), at("mon", "23:00"))).toBe(false);
    expect(isQuietAt(quiet({ days: [] }), at("tue", "07:00"))).toBe(false);
  });

  test("times that cannot be read, or the same time at both ends, hold nothing back", () => {
    expect(isQuietAt(quiet({ from: "24:00" }), at("mon", "23:00"))).toBe(false);
    expect(isQuietAt(quiet({ from: "08:00", to: "08:00" }), at("mon", "08:00"))).toBe(false);
  });
});

describe("the night the clocks change", () => {
  test("in Europe/London, as summer time ends on 25 October 2026, quiet hours begin and end by the clock on the wall", () => {
    vi.stubEnv("TZ", "Europe/London");
    try {
      const HOUR = 3_600_000;
      // Saturday 24 October, 22:00 in summer time, is 21:00 UTC.
      const evening = Date.UTC(2026, 9, 24, 21, 0);
      const rule = quiet({ from: "22:00", to: "08:00", days: ["sat"] });
      expect(isQuietAt(rule, evening - 60_000)).toBe(false);
      expect(isQuietAt(rule, evening)).toBe(true);
      // 01:30 comes twice: in summer time, at 00:30 UTC, and an hour later in winter time.
      const firstHalfPast = Date.UTC(2026, 9, 25, 0, 30);
      expect(new Date(firstHalfPast).getHours()).toBe(1);
      expect(new Date(firstHalfPast + HOUR).getHours()).toBe(1);
      expect(isQuietAt(rule, firstHalfPast)).toBe(true);
      expect(isQuietAt(rule, firstHalfPast + HOUR)).toBe(true);
      // 08:00 on Sunday is in winter time, 08:00 UTC: the night was an hour longer.
      expect(isQuietAt(rule, Date.UTC(2026, 9, 25, 7, 59))).toBe(true);
      expect(isQuietAt(rule, Date.UTC(2026, 9, 25, 8, 0))).toBe(false);

      // An hour of quiet in the hour lived twice holds both times through.
      const twice = quiet({ from: "01:00", to: "02:00", days: ["sun"] });
      expect(isQuietAt(twice, firstHalfPast)).toBe(true);
      expect(isQuietAt(twice, firstHalfPast + HOUR)).toBe(true);
      expect(isQuietAt(twice, firstHalfPast + 2 * HOUR)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("quietOf", () => {
  const rules = { ...DEFAULT_TIME_RULES, quietHours: quiet({ from: "22:00", to: "08:00" }) };

  test("goes by what the collector said in the snapshot, by its own clock, over this one's", () => {
    expect(quietOf({ generatedAt: at("mon", "12:00"), timeRules: rules, quiet: true })).toBe(true);
    expect(quietOf({ generatedAt: at("mon", "23:00"), timeRules: rules, quiet: false })).toBe(
      false,
    );
  });

  test("from a snapshot that did not say, goes by its rules at the moment it was made", () => {
    expect(quietOf({ generatedAt: at("mon", "23:00"), timeRules: rules })).toBe(true);
    expect(quietOf({ generatedAt: at("mon", "12:00"), timeRules: rules })).toBe(false);
    expect(quietOf({ generatedAt: at("mon", "23:00") })).toBe(false);
  });
});
