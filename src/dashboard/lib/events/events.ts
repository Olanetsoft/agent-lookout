/**
 * The rows of the events log, worked out from what the page holds: the events,
 * newest first, the sessions in the latest snapshot, and the history, which
 * says when Agent Lookout started and where its polls broke off.
 */

import type { HistoryResponse } from "@core/api";
import { historySince } from "@core/history";
import { isStatusEvent, type Session, type SessionEvent } from "@core/sessions/session";
import { needsYou } from "@core/waits/answeredWaits";
import type { MarkKind } from "@dashboard/components/ui/status/StatusMark";
import { DEFAULT_GAP_MS } from "@dashboard/lib/charts/sparkline";

export interface LogEntry {
  event: SessionEvent;
  /**
   * The mark beside it: the status the event moved to. A move to "needs you" is
   * the lit lamp while that wait is still open, and the answered mark once it is
   * over, so the log holds amber only for what is waiting now. An ending that
   * names no status has the ended mark, so every row has one, and so has a
   * session Agent Lookout stopped.
   */
  mark: MarkKind;
  /** Whether this is a wait that is still open. */
  open: boolean;
  /**
   * For a move out of "needs you", how long the wait lasted, when the page holds
   * the event that began it. Null otherwise.
   */
  waitedMs: number | null;
}

/**
 * Each event with its mark and, for a wait that ended, how long it lasted.
 *
 * A wait is open while its session is still listed as needing the person and
 * the event that began it is that session's newest. Anything later, or a
 * session that has left the list, means it was answered or is over, and so
 * does a session still listed in a wait Agent Lookout answered (`needsYou`).
 */
export function logEntries(
  events: readonly SessionEvent[],
  sessions: readonly Pick<Session, "id" | "status" | "answered">[],
): LogEntry[] {
  const waiting = new Set(sessions.filter(needsYou).map((session) => session.id));
  // Newest first, so the first event met for a session is its newest, and the
  // next one met is the one just before it.
  const newest = new Set<string>();
  const before = new Map<string, SessionEvent>();
  const olderOf = new Map<SessionEvent, SessionEvent>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    // What Agent Lookout did to a session is no status, so a wait's length is measured past it.
    if (!event || !isStatusEvent(event)) continue;
    const previous = before.get(event.sessionId);
    if (previous) olderOf.set(event, previous);
    before.set(event.sessionId, event);
  }

  return events.map((event) => {
    // Anything later than the event that began a wait ends it as far as the
    // log goes, a stop or an answer from Agent Lookout included.
    const isNewest = !newest.has(event.sessionId);
    newest.add(event.sessionId);

    if (event.to === "needs-you") {
      const open = isNewest && waiting.has(event.sessionId);
      return { event, mark: open ? "needs-you" : "answered", open, waitedMs: null };
    }

    // Being stopped is an ending the person asked for, and has the ended mark.
    if (event.kind === "stopped") return { event, mark: "ended", open: false, waitedMs: null };
    // A prompt answered from here ends that wait, so it has the answered mark.
    if (event.kind === "answered") return { event, mark: "answered", open: false, waitedMs: null };

    const started = olderOf.get(event);
    const waitedMs =
      event.from === "needs-you" && started?.to === "needs-you" ? event.at - started.at : null;
    const mark: MarkKind = event.to ?? (event.kind === "ended" ? "ended" : "unknown");
    return { event, mark, open: false, waitedMs };
  });
}

export interface LogStart {
  /** The moment the log reaches back to. */
  at: number;
  /**
   * True when that is the moment Agent Lookout started watching, or the
   * history was cleared, and the log holds everything since: the log then
   * ends in a "Started watching" row, or a "History cleared" one.
   */
  started: boolean;
  /** Set when the history was cleared then: the row says so. */
  cleared?: true;
}

/**
 * How far back the log reaches. While it holds every event since Agent Lookout
 * started, or since the history was cleared, that is the start, read from the
 * history. Once it is full, older events may have been let go, so it reaches
 * only as far as the oldest one held, and it does not claim to show the start.
 * Where the history kept begins only because what came before it was let go,
 * the log reaches back that far and claims no start either. Without the
 * history's start, and with room to spare, nothing is claimed.
 */
export function logStart(
  events: readonly SessionEvent[],
  history: Pick<HistoryResponse, "startedAt" | "since"> | null,
  full: boolean,
): LogStart | null {
  if (full) {
    const oldest = events[events.length - 1];
    return oldest ? { at: oldest.at, started: false } : null;
  }
  if (!history) return null;
  const since = historySince(history);
  if (since.by === "trimmed") return { at: since.at, started: false };
  return since.by === "cleared"
    ? { at: since.at, started: true, cleared: true }
    : { at: since.at, started: true };
}

/** A break in the collector's polls, found in the history the page holds. */
export interface WatchGap {
  /** When polls began again: the first poll after the break. */
  at: number;
  /** How long nothing was measured. */
  unmeasuredMs: number;
}

/**
 * Every break in the history the page holds, newest first.
 *
 * - Two polls further apart than `gapMs` were not measuring in between, as
 *   while the computer slept. The break is found at the poll that ended it,
 *   which is when watching resumed.
 * - Each time Agent Lookout started again is a break too, from the newest
 *   moment the history before it holds, however short or long ago: the page
 *   holds only the last hour of polls, and a stop of a few seconds leaves no
 *   gap between them. One the polls already show is not said twice.
 *
 * The oldest poll held has nothing before it to measure a break from, so the
 * edge of the held history is never a break, and nor is anything before
 * where the history begins.
 */
export function watchGaps(
  history:
    | (Pick<HistoryResponse, "startedAt" | "since" | "restarts"> &
        Partial<Pick<HistoryResponse, "points">>)
    | null,
  gapMs: number = DEFAULT_GAP_MS,
): WatchGap[] {
  if (!history) return [];
  const from = historySince(history).at;
  const times = (history.points ?? [])
    .map((point) => point.at)
    .filter((at) => at >= from)
    .sort((a, b) => a - b);
  const gaps: (WatchGap & { before: number })[] = [];
  times.forEach((at, index) => {
    const before = times[index - 1];
    if (before !== undefined && at - before > gapMs) {
      gaps.push({ at, unmeasuredMs: at - before, before });
    }
  });
  for (const restart of history.restarts ?? []) {
    if (restart.at <= from) continue;
    const shown = gaps.some((gap) => gap.before < restart.at && restart.at <= gap.at);
    if (shown) continue;
    gaps.push({
      at: restart.at,
      unmeasuredMs: restart.at - restart.lastBefore,
      before: restart.lastBefore,
    });
  }
  return gaps.sort((a, b) => b.at - a.at).map(({ at, unmeasuredMs }) => ({ at, unmeasuredMs }));
}

/** One row of the log: an event, or the moment watching resumed after a break. */
export type LogRow = { kind: "event"; entry: LogEntry } | { kind: "resumed"; gap: WatchGap };

/**
 * The events and the breaks in one list, newest first. A break sits below the
 * events that share its time, because those changes were found by the poll that
 * ended it, and so happened during the break or as it ended.
 */
export function logRows(entries: readonly LogEntry[], gaps: readonly WatchGap[]): LogRow[] {
  const rows: LogRow[] = [];
  let next = 0;
  for (const entry of entries) {
    while (next < gaps.length && (gaps[next] as WatchGap).at > entry.event.at) {
      rows.push({ kind: "resumed", gap: gaps[next] as WatchGap });
      next += 1;
    }
    rows.push({ kind: "event", entry });
  }
  for (; next < gaps.length; next += 1) rows.push({ kind: "resumed", gap: gaps[next] as WatchGap });
  return rows;
}
