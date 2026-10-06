/**
 * How long sessions waited on the person today and over the last seven days,
 * as the Waits card says it. The collector works the totals out from the
 * whole of the history it keeps, `GET /api/waits`, and the page only reads
 * them: it holds an hour of history, and a week is far more.
 */

import type { SessionWaitTotal, WaitDay, WaitPeriod, WaitsResponse, WaitTotal } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readWaits } from "@dashboard/lib/api/readApi";
import { clockAt, durationInWords, formatDuration, startOfDay } from "@dashboard/lib/format";

/** How often the card asks again while it is on the page. */
export const WAITS_REFRESH_MS = 30_000;

/** A request is not left waiting on a server that has stopped answering. */
const WAITS_TIMEOUT_MS = 4_000;

/** Asks the app how long sessions waited. Null when it did not answer, or answered with something else. */
export async function fetchWaitTotals(): Promise<WaitsResponse | null> {
  try {
    const response = await apiRequest("/api/waits", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(WAITS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readWaits(await response.json());
  } catch {
    return null;
  }
}

/** Whether any of a stretch was measured. A figure for a stretch nobody measured is a dash. */
export function wasMeasured(total: WaitTotal): boolean {
  return total.measuredMs > 0;
}

/** "1 wait", "6 waits", "No waits", or "Not measured". */
export function waitsCount(total: WaitTotal): string {
  if (!wasMeasured(total)) return "Not measured";
  if (total.waits === 0) return "No waits";
  return `${total.waits} ${total.waits === 1 ? "wait" : "waits"}`;
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

const longFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

/** A day of the list: "Today", "Yesterday", or "Sat, Oct 3". `long` spells it out for a screen reader. */
export function dayLabel(day: Pick<WaitDay, "from">, now: number, long = false): string {
  const today = startOfDay(now);
  const start = startOfDay(day.from);
  if (start === today) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (start === yesterday.getTime()) return "Yesterday";
  return (long ? longFormat : weekdayFormat).format(new Date(day.from));
}

/**
 * The part of a day's bar that is a wait still open. Only today's is: a wait
 * open since yesterday was answered for yesterday's part, as far as its bar is
 * concerned, so amber is only ever at now.
 */
export function openPart(day: WaitDay, now: number): number {
  return startOfDay(day.from) === startOfDay(now) ? day.openMs : 0;
}

/** One day's bar in words: "Today: waited 42 minutes in 6 waits, still waiting, measured for 9 hours 12 minutes". */
export function dayInWords(day: WaitDay, now: number): string {
  const name = dayLabel(day, now, true);
  if (!wasMeasured(day)) return `${name}: not measured`;
  const waited =
    day.waits === 0
      ? "no session waited"
      : `waited ${durationInWords(day.waitedMs)} in ${waitsCount(day).toLowerCase()}`;
  const open = openPart(day, now) > 0 ? ", still waiting" : "";
  return `${name}: ${waited}${open}, measured for ${durationInWords(day.measuredMs)}`;
}

/** "9h 12m of today", or "none of today" when nothing of it was measured. */
function partOf(total: WaitTotal, of: string): string {
  return wasMeasured(total) ? `${formatDuration(total.measuredMs)} of ${of}` : `none of ${of}`;
}

/**
 * What the totals cover, plainly: only the time Agent Lookout was running,
 * and how much of each period that was. With history kept in memory only, it
 * covers only the time since this run started; with history on disk that
 * begins inside the seven days, it says where.
 */
export function coverageNote(waits: WaitsResponse): string {
  const { today, sevenDays, since, at } = waits;
  if (waits.where === "memory") {
    // Since the start, the 7 days and today are the same time, unless this run went on across midnight.
    const week =
      sevenDays.measuredMs === today.measuredMs
        ? ""
        : `, and ${partOf(sevenDays, "the last 7 days")}`;
    return `History is kept in memory only, because AGENT_LOOKOUT_HISTORY is set to off, so only the time since Agent Lookout started at ${clockAt(since.at, at)} is counted: ${partOf(today, "today")} so far${week}.`;
  }
  const counted = `Only the time Agent Lookout was running is counted: ${partOf(today, "today")} so far, and ${partOf(sevenDays, "the last 7 days")}.`;
  if (since.at <= sevenDays.from) return counted;
  return since.by === "cleared"
    ? `${counted} The history was cleared at ${clockAt(since.at, at)}.`
    : `${counted} The history it keeps begins at ${clockAt(since.at, at)}.`;
}

/**
 * The totals as they stand at `at`, a moment after the answer: each wait still
 * open has gone on, and Agent Lookout gone on measuring, for the time since.
 * The page asks every 30 seconds, and the hero and Last hour move each second,
 * so between answers this moves with them. Past midnight it waits for the next
 * answer, which begins the new day.
 */
export function waitsAt(waits: WaitsResponse, at: number): WaitsResponse {
  const gone = at - waits.at;
  if (gone <= 0 || startOfDay(at) !== startOfDay(waits.at) || !wasMeasured(waits.today)) {
    return waits;
  }
  const open = new Set(
    [...waits.today.sessions, ...waits.sevenDays.sessions]
      .filter((session) => session.open)
      .map((session) => session.sessionId),
  );
  const grown = <T extends WaitTotal>(total: T): T => ({
    ...total,
    waitedMs: total.waitedMs + open.size * gone,
    openMs: total.openMs + open.size * gone,
    measuredMs: total.measuredMs + gone,
  });
  const session = (each: SessionWaitTotal): SessionWaitTotal =>
    each.open ? { ...each, waitedMs: each.waitedMs + gone } : each;
  const period = (chosen: WaitPeriod): WaitPeriod => ({
    ...grown(chosen),
    to: at,
    days: chosen.days.map((day, index) =>
      index === chosen.days.length - 1 ? { ...grown(day), to: at } : day,
    ),
    sessions: chosen.sessions
      .map(session)
      .sort((a, b) => b.waitedMs - a.waitedMs || a.name.localeCompare(b.name)),
  });
  return { ...waits, at, today: period(waits.today), sevenDays: period(waits.sevenDays) };
}

/** Why the list of longest waits is empty, for the period it covers. */
export function noWaitsLine(total: WaitTotal, period: "today" | "sevenDays"): string {
  const when = period === "today" ? "today" : "in the last 7 days";
  return wasMeasured(total) ? `No session waited on you ${when}.` : `Nothing was measured ${when}.`;
}
