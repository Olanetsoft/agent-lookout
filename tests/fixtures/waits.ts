// Test fixtures only. Product code never imports this file: the product never
// shows invented data.

import type { WaitDay, WaitPeriod, WaitsResponse } from "@core/api";

const HOUR = 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dayOf(from: number, to: number): WaitDay {
  const date = new Date(from);
  return {
    day: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    from,
    to,
    waitedMs: 0,
    openMs: 0,
    waits: 0,
    measuredMs: Math.min(to - from, HOUR),
  };
}

function periodOf(days: WaitDay[]): WaitPeriod {
  return {
    from: (days[0] as WaitDay).from,
    to: (days[days.length - 1] as WaitDay).to,
    waitedMs: 0,
    openMs: 0,
    waits: 0,
    measuredMs: days.reduce((sum, day) => sum + day.measuredMs, 0),
    days,
    sessions: [],
    sessionCount: 0,
  };
}

/**
 * An answer of `GET /api/waits` at `now` in which no session waited: an hour
 * measured on each of the seven local days, today's among them, with the
 * history kept on disk from before them.
 */
export function quietWaits(now: number): WaitsResponse {
  const days: WaitDay[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - back);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    days.push(dayOf(start.getTime(), Math.min(end.getTime(), now)));
  }
  return {
    at: now,
    today: periodOf(days.slice(-1)),
    sevenDays: periodOf(days),
    since: { at: (days[0] as WaitDay).from - 24 * HOUR, by: "started" },
    where: "disk",
  };
}
