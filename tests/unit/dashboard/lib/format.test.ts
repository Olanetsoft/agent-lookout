import { expect, test } from "vitest";

import {
  durationInWords,
  formatAgo,
  formatClock,
  formatClockMinutes,
  formatDay,
  formatFullTime,
  formatShortDuration,
  formatSince,
  shortDurationInWords,
  startOfDay,
} from "@dashboard/lib/format";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test.each([
  [0, "0s", "0 seconds"],
  [42 * SECOND, "42s", "42 seconds"],
  [59 * SECOND + 999, "59s", "59 seconds"],
  [MINUTE, "1m", "1 minute"],
  [34 * MINUTE + 59 * SECOND, "34m", "34 minutes"],
  [59 * MINUTE + 59 * SECOND, "59m", "59 minutes"],
  [HOUR + 4 * MINUTE + 50 * SECOND, "1h 04m", "1 hour 4 minutes"],
  [23 * HOUR + 59 * MINUTE + 59 * SECOND, "23h 59m", "23 hours 59 minutes"],
  [DAY, "1d", "1 day"],
  [6 * DAY + 3 * HOUR + 12 * MINUTE, "6d", "6 days"],
])("the short form a table row uses: %i ms is %s, read as %s", (ms, text, words) => {
  // Seconds only in the first minute, days alone, and never rounded up.
  expect(formatShortDuration(ms)).toBe(text);
  expect(shortDurationInWords(ms)).toBe(words);
});

test("a duration in words is singular for one and plural otherwise", () => {
  expect(durationInWords(MINUTE + SECOND)).toBe("1 minute 1 second");
  expect(durationInWords(2 * HOUR + 4 * MINUTE)).toBe("2 hours 4 minutes");
});

test("ago says just now inside the first second", () => {
  expect(formatAgo(400)).toBe("just now");
  expect(formatAgo(2 * SECOND)).toBe("2s ago");
});

test("the clock is local, 24-hour and zero-padded", () => {
  const at = new Date(2026, 0, 5, 9, 4, 7).getTime();
  expect(formatClock(at)).toBe("09:04:07");
});

test("the clock to the minute is the same 24-hour clock without its seconds", () => {
  expect(formatClockMinutes(new Date(2026, 0, 5, 9, 4, 7).getTime())).toBe("09:04");
  expect(formatClockMinutes(new Date(2026, 0, 5, 23, 59, 59).getTime())).toBe("23:59");
});

test("a full time carries the date and the same 24-hour clock as the rest of the page", () => {
  const afternoon = new Date(2026, 8, 30, 14, 12, 24).getTime();
  const full = formatFullTime(afternoon);

  // The date's wording depends on the machine's locale. The clock does not.
  expect(full.endsWith(" 14:12:24")).toBe(true);
  expect(full).toContain("30");
  expect(full).toContain("2026");
  expect(full).not.toMatch(/[AP]M/i);
});

test("since is the clock alone today, and carries the date for an earlier day", () => {
  const now = new Date(2026, 9, 3, 18, 0, 0).getTime();
  const thisMorning = new Date(2026, 9, 3, 9, 4, 7).getTime();
  const daysAgo = new Date(2026, 8, 27, 14, 12, 7).getTime();

  expect(formatSince(thisMorning, now)).toBe("09:04:07");
  expect(formatSince(daysAgo, now)).toBe(formatFullTime(daysAgo));
  expect(formatSince(daysAgo, now)).toContain("27");
  expect(formatSince(daysAgo, now).endsWith(" 14:12:07")).toBe(true);
});

test("two moments share a start of day only when they are on one local day", () => {
  const morning = new Date(2026, 0, 5, 0, 0, 1).getTime();
  const night = new Date(2026, 0, 5, 23, 59, 59).getTime();
  const nextDay = new Date(2026, 0, 6, 0, 0, 0).getTime();

  expect(startOfDay(morning)).toBe(startOfDay(night));
  expect(startOfDay(nextDay)).not.toBe(startOfDay(night));
  expect(startOfDay(morning)).toBe(new Date(2026, 0, 5).getTime());
});

test("a day heading names the day, and the year only when it is another year", () => {
  const now = new Date(2026, 0, 5, 18, 0, 0).getTime();
  const yesterday = formatDay(new Date(2026, 0, 4, 23, 59, 59).getTime(), now);
  const lastYear = formatDay(new Date(2025, 11, 31, 8, 0, 0).getTime(), now);

  // The wording depends on the machine's locale. It is a day, never a clock.
  expect(yesterday).toContain("4");
  expect(yesterday).not.toMatch(/\d\d:\d\d/);
  expect(yesterday).not.toContain("2026");
  expect(lastYear).toContain("31");
  expect(lastYear).toContain("2025");
});
