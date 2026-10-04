/**
 * The scales of a history chart: where the count axis tops out, and which clock
 * times the time axis marks. The line itself comes from `buildSteps`.
 */

import type { HistoryResponse } from "@core/api";
import type { HistoryPoint } from "@core/session";
import type { SparkSample } from "@dashboard/lib/sparkline";

const MINUTE = 60_000;

/** The counts that have a history dialog behind them. */
export type HistoryMetric = "needsYou" | "working" | "idle";

/** One count out of every history point, as samples for a line. */
export function samplesOf(points: readonly HistoryPoint[], metric: HistoryMetric): SparkSample[] {
  return points.map((point) => ({ at: point.at, value: point[metric] }));
}

/** The windows a history panel offers. The collector keeps six hours. */
export const HISTORY_WINDOWS = [
  { id: "15m", label: "15 min", ms: 15 * MINUTE, words: "the last 15 minutes" },
  { id: "1h", label: "1 hour", ms: 60 * MINUTE, words: "the last hour" },
  { id: "6h", label: "6 hours", ms: 360 * MINUTE, words: "the last 6 hours" },
] as const;

export type HistoryWindowId = (typeof HISTORY_WINDOWS)[number]["id"];

export interface CountAxis {
  /** The value at the top of the plot. */
  ceiling: number;
  /** The values that get a grid line and a label, from zero up to the ceiling. */
  ticks: number[];
}

/** Whole steps that read well on an axis of counts. */
const COUNT_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1_000];

/**
 * An axis for whole counts: it starts at zero, ends on a whole step at or above
 * the highest count, and has at most five lines.
 */
export function countAxis(max: number): CountAxis {
  const top = Math.max(1, Math.ceil(max));
  const step = COUNT_STEPS.find((candidate) => top / candidate <= 4) ?? Math.ceil(top / 4);
  const ceiling = Math.ceil(top / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= ceiling; value += step) ticks.push(value);
  return { ceiling, ticks };
}

/** Gaps between marks on the time axis, in minutes. */
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360];

/**
 * The clock times to mark between `start` and `end`: round times on the local
 * clock, as many as fit without crowding.
 */
export function timeTicks(start: number, end: number, maxTicks: number): number[] {
  const span = end - start;
  if (span <= 0 || maxTicks < 1) return [];
  const step =
    (TIME_STEPS.find((minutes) => span / (minutes * MINUTE) <= maxTicks) ?? 720) * MINUTE;
  // Round on the local clock, not on UTC: some time zones sit at a half hour.
  const offset = new Date(start).getTimezoneOffset() * MINUTE;
  const ticks: number[] = [];
  for (let at = Math.ceil((start - offset) / step) * step + offset; at <= end; at += step) {
    ticks.push(at);
  }
  return ticks;
}

/**
 * A long window of history, kept current. `base` was asked for once and covers
 * the whole window; `live` is the short window the page polls on every beat.
 * The result is the older part of `base` followed by all of `live`, so the chart
 * moves with every poll without asking for thousands of points each time.
 */
export function mergeHistory(base: HistoryResponse, live: HistoryResponse | null): HistoryResponse {
  const firstLive = live?.points[0];
  if (!live || !firstLive || live.startedAt !== base.startedAt) return base;
  const older = base.points.filter((point) => point.at < firstLive.at);
  return { startedAt: base.startedAt, points: [...older, ...live.points] };
}
