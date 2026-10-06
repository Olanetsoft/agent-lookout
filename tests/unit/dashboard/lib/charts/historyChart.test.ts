import { expect, test } from "vitest";

import {
  clearedSince,
  countAxis,
  HISTORY_WINDOWS,
  mergeHistory,
  samplesOf,
  timeTicks,
} from "@dashboard/lib/charts/historyChart";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test.each([
  [0, 1, [0, 1]],
  [1, 1, [0, 1]],
  [3, 3, [0, 1, 2, 3]],
  [4, 4, [0, 1, 2, 3, 4]],
  [5, 6, [0, 2, 4, 6]],
  [8, 8, [0, 2, 4, 6, 8]],
  [9, 10, [0, 5, 10]],
  [15, 15, [0, 5, 10, 15]],
  [37, 40, [0, 10, 20, 30, 40]],
  [120, 150, [0, 50, 100, 150]],
])("an axis for a highest count of %d tops out at %d", (max, ceiling, ticks) => {
  expect(countAxis(max)).toEqual({ ceiling, ticks });
});

test("the count axis is whole numbers from zero, with at most five lines", () => {
  for (let max = 0; max <= 400; max += 1) {
    const { ceiling, ticks } = countAxis(max);
    expect(ceiling).toBeGreaterThanOrEqual(Math.max(1, max));
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(ceiling);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ticks.every(Number.isInteger)).toBe(true);
  }
});

test("time marks fall on round local clock times, inside the window", () => {
  const end = new Date(2026, 0, 5, 18, 3, 20).getTime();
  const start = end - 15 * MINUTE;

  const ticks = timeTicks(start, end, 8);
  const clocks = ticks.map((at) => {
    const date = new Date(at);
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}:${date.getSeconds()}`;
  });

  expect(clocks).toEqual([
    "17:50:0",
    "17:52:0",
    "17:54:0",
    "17:56:0",
    "17:58:0",
    "18:00:0",
    "18:02:0",
  ]);
  expect(ticks.every((at) => at >= start && at <= end)).toBe(true);
});

test("a longer window or a narrower chart gets marks further apart, never crowded", () => {
  const end = new Date(2026, 0, 5, 18, 3, 20).getTime();
  const minutesApart = (windowMs: number, maxTicks: number) => {
    const ticks = timeTicks(end - windowMs, end, maxTicks);
    expect(ticks.length).toBeLessThanOrEqual(maxTicks);
    expect(ticks.length).toBeGreaterThan(0);
    return ((ticks[1] ?? 0) - (ticks[0] ?? 0)) / MINUTE;
  };

  expect(minutesApart(15 * MINUTE, 8)).toBe(2);
  expect(minutesApart(15 * MINUTE, 3)).toBe(5);
  expect(minutesApart(HOUR, 8)).toBe(10);
  expect(minutesApart(6 * HOUR, 8)).toBe(60);
  expect(minutesApart(6 * HOUR, 4)).toBe(120);
  expect(timeTicks(end, end, 8)).toEqual([]);
});

test("the windows on offer end with the six hours the collector keeps", () => {
  expect(HISTORY_WINDOWS.map((window) => window.ms)).toEqual([15 * MINUTE, HOUR, 6 * HOUR]);
});

const point = (at: number, needsYou: number) => ({ at, needsYou, working: 1, idle: 2, total: 5 });

test("one count is read out of every history point", () => {
  const points = [point(1_000, 0), point(3_000, 2)];

  expect(samplesOf(points, "needsYou")).toEqual([
    { at: 1_000, value: 0 },
    { at: 3_000, value: 2 },
  ]);
  expect(samplesOf(points, "idle").map((sample) => sample.value)).toEqual([2, 2]);
});

test("a long window is its older part followed by everything polled since", () => {
  const base = { startedAt: 500, points: [point(1_000, 0), point(3_000, 1), point(5_000, 1)] };
  // The polled window overlaps the end of the long one and runs past it.
  const live = { startedAt: 500, points: [point(3_000, 1), point(5_000, 1), point(7_000, 4)] };

  const merged = mergeHistory(base, live);

  expect(merged.points.map((p) => p.at)).toEqual([1_000, 3_000, 5_000, 7_000]);
  expect(merged.points[3]?.needsYou).toBe(4);
  expect(merged.startedAt).toBe(500);
});

test("where the history begins and where it is kept come from what was polled last", () => {
  const base = {
    startedAt: 500,
    since: { at: 100, by: "started" as const },
    points: [point(1_000, 0)],
  };
  const live = {
    startedAt: 500,
    since: { at: 900, by: "trimmed" as const },
    points: [point(3_000, 1)],
  };
  expect(mergeHistory(base, live)).toEqual({
    startedAt: 500,
    since: { at: 900, by: "trimmed" },
    points: [point(1_000, 0), point(3_000, 1)],
  });
});

test("once the history has been cleared, what the long window held from before goes", () => {
  const base = { startedAt: 500, points: [point(1_000, 0), point(3_000, 1)] };
  const live = { startedAt: 500, since: { at: 4_000, by: "cleared" as const }, points: [] };
  expect(mergeHistory(base, live)).toBe(live);
  expect(clearedSince(base, live)).toBe(true);
  // A clearing the page already held is not news.
  const later = { ...live, points: [point(5_000, 0)] };
  expect(clearedSince(live, later)).toBe(false);
  // Nor is a beginning that was not a clearing.
  expect(clearedSince(base, { ...live, since: { at: 4_000, by: "trimmed" } })).toBe(false);
});

test("with nothing polled, or polled from a restarted collector, the long window stands alone", () => {
  const base = { startedAt: 500, points: [point(1_000, 0)] };

  expect(mergeHistory(base, null)).toBe(base);
  expect(mergeHistory(base, { startedAt: 500, points: [] })).toBe(base);
  expect(mergeHistory(base, { startedAt: 9_000, points: [point(9_500, 2)] })).toBe(base);
});
