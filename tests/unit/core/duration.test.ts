import { expect, test } from "vitest";

import { durationParts, formatDuration } from "@core/duration";

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
