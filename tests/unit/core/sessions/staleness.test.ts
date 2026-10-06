import { expect, test } from "vitest";

import { isStale, STALE_THRESHOLD_MS, staleAfterInWords } from "@core/sessions/staleness";

const now = 1_700_000_000_000;
const hour = 60 * 60 * 1000;

test("the threshold is 24 hours", () => {
  expect(STALE_THRESHOLD_MS).toBe(24 * hour);
});

test("an idle session becomes stale exactly at the threshold", () => {
  expect(isStale({ status: "idle", statusSince: now - 24 * hour + 1 }, now)).toBe(false);
  expect(isStale({ status: "idle", statusSince: now - 24 * hour }, now)).toBe(true);
  expect(isStale({ status: "idle", statusSince: now - 7 * 24 * hour }, now)).toBe(true);
});

test("only idle sessions can be stale, however old their status is", () => {
  const since = now - 30 * 24 * hour;
  for (const status of ["needs-you", "working", "finished", "failed", "unknown"] as const) {
    expect(isStale({ status, statusSince: since }, now)).toBe(false);
  }
});

test("an idle session with no reported status time is not called stale", () => {
  expect(isStale({ status: "idle", statusSince: null }, now)).toBe(false);
});

test("a status time in the future is not stale", () => {
  expect(isStale({ status: "idle", statusSince: now + hour }, now)).toBe(false);
});

test("the threshold can be overridden", () => {
  expect(isStale({ status: "idle", statusSince: now - 5_000 }, now, 5_000)).toBe(true);
  expect(isStale({ status: "idle", statusSince: now - 4_999 }, now, 5_000)).toBe(false);
});

test.each([
  [24 * hour, "a day"],
  [48 * hour, "2 days"],
  [30 * 24 * hour, "30 days"],
  [hour, "an hour"],
  [36 * hour, "36 hours"],
  [5 * hour, "5 hours"],
])("a threshold of %i ms is said as %s", (ms, words) => {
  expect(staleAfterInWords(ms)).toBe(words);
});
