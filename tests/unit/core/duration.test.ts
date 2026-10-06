import { expect, test } from "vitest";

import { clockAt, durationInWords, durationParts, formatDuration } from "@core/duration";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test.each([
  [0, "0s"],
  [999, "0s"],
  [42 * SECOND, "42s"],
  [59 * SECOND + 999, "59s"],
  [MINUTE, "1m 00s"],
  [4 * MINUTE + 12 * SECOND, "4m 12s"],
  [59 * MINUTE + 59 * SECOND, "59m 59s"],
  [HOUR, "1h 00m"],
  [HOUR + 4 * MINUTE + 50 * SECOND, "1h 04m"],
  [23 * HOUR + 59 * MINUTE, "23h 59m"],
  [DAY, "1d 00h"],
  [6 * DAY + 2 * HOUR + 30 * MINUTE, "6d 02h"],
])("%d ms reads as %s", (ms, expected) => {
  expect(formatDuration(ms)).toBe(expected);
});

test("a duration never shows more than two units", () => {
  for (const ms of [0, 5 * SECOND, 5 * MINUTE, 5 * HOUR, 5 * DAY, 400 * DAY]) {
    expect(durationParts(ms).length).toBeLessThanOrEqual(2);
  }
});

test("a negative duration, from a clock that is slightly ahead, reads as zero", () => {
  expect(formatDuration(-1_500)).toBe("0s");
});

test("a length of time in words leaves out a smaller unit that is zero", () => {
  expect(durationInWords(0)).toBe("0 seconds");
  expect(durationInWords(SECOND)).toBe("1 second");
  expect(durationInWords(59 * SECOND + 999)).toBe("59 seconds");
  expect(durationInWords(MINUTE)).toBe("1 minute");
  expect(durationInWords(MINUTE + 5 * SECOND)).toBe("1 minute 5 seconds");
  expect(durationInWords(59 * MINUTE + 59 * SECOND)).toBe("59 minutes 59 seconds");
  expect(durationInWords(HOUR)).toBe("1 hour");
  expect(durationInWords(2 * HOUR + 3 * MINUTE)).toBe("2 hours 3 minutes");
  expect(durationInWords(25 * HOUR)).toBe("1 day 1 hour");
  expect(durationInWords(3 * DAY)).toBe("3 days");
});

test("a time is on this computer's 24-hour clock, with the day when it is not today", () => {
  const evening = new Date(2026, 9, 4, 23, 59, 30).getTime();
  expect(clockAt(evening, evening + 1_000)).toBe("23:59");
  expect(clockAt(evening, new Date(2026, 9, 5, 0, 0, 30).getTime())).toMatch(
    /^23:59 on \S+ 4$|^23:59 on 4 \S+$/,
  );
});
