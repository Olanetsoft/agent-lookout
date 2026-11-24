import { afterEach, expect, test } from "vitest";

import { followZone, localDate } from "@core/time-rules/localTime";

afterEach(() => followZone(null));

/** A moment as `localDate` gives it, such as `2026-11-24T03:00:00.250`. */
const local = (at: number) => localDate(at).toISOString().slice(0, -1);

test("until a zone is named, the local clock is the one Date reads", () => {
  for (const [month, day] of [
    [0, 5],
    [6, 5],
    [11, 31],
  ] as const) {
    const at = new Date(2026, month, day, 23, 59, 30, 250).getTime();
    expect(local(at)).toBe(
      `2026-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59:30.250`,
    );
  }
});

test("a zone named is gone by from then on, through its own clock changes, until null names none", () => {
  const at = Date.UTC(2026, 10, 24, 8, 0, 0, 250);
  const before = local(at);
  followZone("America/New_York");
  expect(local(at)).toBe("2026-11-24T03:00:00.250");
  expect(local(Date.UTC(2026, 6, 24, 8))).toBe("2026-07-24T04:00:00.000");
  // Midnight, and a day before it there.
  expect(local(Date.UTC(2027, 0, 1, 5))).toBe("2027-01-01T00:00:00.000");
  expect(local(Date.UTC(2027, 0, 1, 4, 59))).toBe("2026-12-31T23:59:00.000");
  followZone("Asia/Kolkata");
  expect(local(at)).toBe("2026-11-24T13:30:00.250");
  followZone(null);
  expect(local(at)).toBe(before);
});

test("a name that is no zone's is refused, and the one gone by stays", () => {
  followZone("Asia/Tokyo");
  expect(() => followZone("Nowhere/None")).toThrow(RangeError);
  expect(local(Date.UTC(2026, 10, 24, 8))).toBe("2026-11-24T17:00:00.000");
});
