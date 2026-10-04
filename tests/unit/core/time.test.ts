import { describe, expect, test } from "vitest";

import { CLOCK_SLACK_MS, EARLIEST_PLAUSIBLE_TIME_MS, plausibleTime } from "@core/time";

const now = 1_700_000_100_000;

describe("plausibleTime", () => {
  test("a time in the recent past is kept as it is", () => {
    expect(plausibleTime(1_700_000_000_000, now)).toBe(1_700_000_000_000);
    expect(plausibleTime(now, now)).toBe(now);
    expect(plausibleTime(EARLIEST_PLAUSIBLE_TIME_MS, now)).toBe(EARLIEST_PLAUSIBLE_TIME_MS);
  });

  test("zero and negative times are not known", () => {
    expect(plausibleTime(0, now)).toBeNull();
    expect(plausibleTime(-5, now)).toBeNull();
  });

  test("seconds given where milliseconds were expected are not known", () => {
    // 1,700,000,000 milliseconds is a day in January 1970.
    expect(plausibleTime(1_700_000_000, now)).toBeNull();
    expect(plausibleTime(EARLIEST_PLAUSIBLE_TIME_MS - 1, now)).toBeNull();
  });

  test("a time that is not a whole number is not known", () => {
    expect(plausibleTime(1.5, now)).toBeNull();
    expect(plausibleTime(1_700_000_000_000.5, now)).toBeNull();
    expect(plausibleTime(Number.NaN, now)).toBeNull();
    expect(plausibleTime(Number.POSITIVE_INFINITY, now)).toBeNull();
  });

  test("a time well ahead of the clock is not known", () => {
    expect(plausibleTime(now + 60 * 60 * 1000, now)).toBeNull();
    expect(plausibleTime(now + CLOCK_SLACK_MS + 1, now)).toBeNull();
  });

  test("a time a few seconds ahead is kept: the status changed while the poll ran", () => {
    expect(plausibleTime(now + 4_000, now)).toBe(now + 4_000);
    expect(plausibleTime(now + CLOCK_SLACK_MS, now)).toBe(now + CLOCK_SLACK_MS);
  });

  test("anything that is not a number is not known", () => {
    expect(plausibleTime("1700000000000", now)).toBeNull();
    expect(plausibleTime(null, now)).toBeNull();
    expect(plausibleTime(undefined, now)).toBeNull();
    expect(plausibleTime({}, now)).toBeNull();
  });
});
