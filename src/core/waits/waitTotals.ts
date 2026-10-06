// How long sessions waited on the person today and over the last seven days,
// worked out from the history kept: the events into and out of needs-you, the
// stretches Agent Lookout measured, and the sessions waiting now. Pure, with no
// Node API, so it is tested with a clock and a history of a test's own.
//
// Only time that was measured is counted. A wait that runs on while Agent
// Lookout was stopped, or the computer slept, counts for the time either side
// that was measured, and is still one wait. Each session's waits are added up,
// so two sessions waiting at once for a minute are two minutes.
//
// Only Claude Code sessions and sessions from status files can be seen waiting.
// A Codex session never shows as needing the person, so it never counts here.

import type { SessionWaitTotal, WaitDay, WaitPeriod } from "../api.ts";
import { isStatusEvent, type SessionEvent } from "../sessions/session.ts";
import { coveredWithin, joined, POLL_GAP_MS, type Span } from "./measured.ts";

/** The most sessions an answer names for each period, longest first. */
export const MAX_WAIT_SESSIONS = 10;

/** How many local days "the last seven days" are: today and the six before it. */
export const WAIT_DAYS = 7;

/**
 * Whether an event moves a session into needs-you or out of it: the only
 * events a wait is made of. What Agent Lookout did to a waiting session, a
 * `stopped` or an `answered` event, is not a move: the move out is the status
 * event that follows it, so the wait is still one wait.
 */
export function isWaitEvent(event: Pick<SessionEvent, "kind" | "from" | "to">): boolean {
  if (!isStatusEvent(event)) return false;
  return event.to === "needs-you" || event.from === "needs-you";
}

/**
 * The move into needs-you of each session whose last wait the events hold no
 * end for. Any event after such a move is a move out of needs-you, so it is
 * the session's newest event of all, and says what it was last doing.
 */
export function unendedWaits(events: readonly SessionEvent[]): SessionEvent[] {
  const newest = new Map<string, SessionEvent>();
  for (const event of events) {
    if (!isWaitEvent(event)) continue;
    const held = newest.get(event.sessionId);
    if (!held || event.at >= held.at) newest.set(event.sessionId, event);
  }
  return [...newest.values()].filter((event) => event.kind !== "ended" && event.to === "needs-you");
}

export interface WaitTotalsInput {
  /** The events into and out of needs-you the history holds, in any order. Others are passed over. */
  events: readonly SessionEvent[];
  /** The stretches Agent Lookout measured, in any order. */
  measured: readonly Span[];
  /**
   * When each run of Agent Lookout began, in any order. A wait whose start the
   * history does not hold is counted from the run it was seen in.
   */
  runStarts: readonly number[];
  /** The sessions that need the person now, as the latest poll found them. */
  waitingNow: readonly { id: string; name: string }[];
  /**
   * The name of every session the latest poll found, waiting or not. A session
   * is named by it first, then by its newest event.
   */
  names?: ReadonlyMap<string, string>;
  /** Where the history held begins. Nothing before it is counted. */
  since: number;
  /** The present. Both periods end here. */
  now: number;
  /** The newest stretch reaches the present while the last poll is no older than this. */
  gapMs?: number;
}

/** One wait of one session: from when it began, or as far back as is known, to when it ended. */
export interface Wait {
  sessionId: string;
  from: number;
  to: number;
  /** Still under way: the session needs the person now. */
  open: boolean;
}

/** The start of a moment's local day. */
function midnightOf(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The local midnight `days` days after the one given, which is a day of 23 or 25 hours where the clocks change. */
function midnightAfter(midnight: number, days: number): number {
  const date = new Date(midnight);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** A local day as `2026-10-06`. */
function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** The latest of `starts` at or before `at`, or `fallback` when none is. `starts` is in time order. */
function latestAtOrBefore(starts: readonly number[], at: number, fallback: number): number {
  let found = fallback;
  for (const start of starts) {
    if (start > at) break;
    found = Math.max(found, start);
  }
  return found;
}

/**
 * Every wait the history holds, oldest first: a move into needs-you, to the
 * session's next move out of it. A wait that was already under way when the
 * history first saw the session, such as one Agent Lookout found as it
 * started, is counted from that run's start, or from the session's previous
 * event when that is later. A wait with no end runs to the present, and is
 * open while the session still needs the person. One that began before this
 * run, of a session that does not need the person now, ended unseen while
 * Agent Lookout was stopped: this run's polls never saw it waiting, so it runs
 * to this run's start and no further.
 */
export function waitsOf(input: WaitTotalsInput): { waits: Wait[]; names: Map<string, string> } {
  const { now, since } = input;
  const starts = [...input.runStarts].sort((a, b) => a - b);
  const runStart = (at: number) => latestAtOrBefore(starts, at, since);
  const waitingNow = new Map(input.waitingNow.map((session) => [session.id, session.name]));
  const thisRun = runStart(now);

  const bySession = new Map<string, SessionEvent[]>();
  for (const event of input.events) {
    if (!isWaitEvent(event) || event.at > now) continue;
    const own = bySession.get(event.sessionId);
    if (own) own.push(event);
    else bySession.set(event.sessionId, [event]);
  }

  const waits: Wait[] = [];
  const names = new Map<string, string>();
  /** The sessions whose last wait has no end. */
  const unended = new Set<string>();
  for (const [sessionId, own] of bySession) {
    own.sort((a, b) => a.at - b.at);
    let began: number | null = null;
    let previous: number | null = null;
    for (const event of own) {
      // A move out of needs-you with no move into it held: it was waiting
      // already, for as long as this run of Agent Lookout had seen it.
      if (began === null && event.from === "needs-you") {
        began = Math.max(runStart(event.at), previous ?? -Infinity);
      }
      const waitsAfter = event.kind !== "ended" && event.to === "needs-you";
      if (began !== null && !waitsAfter) {
        waits.push({ sessionId, from: began, to: event.at, open: false });
        began = null;
      } else if (began === null && waitsAfter) {
        began = event.at;
      }
      previous = event.at;
      names.set(sessionId, event.sessionName);
    }
    if (began !== null) {
      const open = waitingNow.has(sessionId);
      waits.push({ sessionId, from: began, to: open || began >= thisRun ? now : thisRun, open });
      unended.add(sessionId);
    }
  }
  for (const [sessionId, name] of input.names ?? []) names.set(sessionId, name);

  // A session waiting now that no event says began to wait was found waiting
  // by this run: it is counted from when this run began.
  for (const [sessionId, name] of waitingNow) {
    names.set(sessionId, name);
    if (unended.has(sessionId)) continue;
    const own = bySession.get(sessionId);
    const last = own?.[own.length - 1]?.at ?? -Infinity;
    waits.push({ sessionId, from: Math.max(thisRun, last), to: now, open: true });
  }

  const kept = waits
    .map((wait) => ({ ...wait, from: Math.max(wait.from, since) }))
    .filter((wait) => wait.to > wait.from);
  kept.sort((a, b) => a.from - b.from);
  return { waits: kept, names };
}

/** What a stretch of time held: how long was waited in it, how much of that is open, how many waits and how much was measured. */
function totalIn(waits: readonly Wait[], measured: readonly Span[], from: number, to: number) {
  let waitedMs = 0;
  let openMs = 0;
  let count = 0;
  const bySession = new Map<string, { ms: number; waits: number; open: boolean }>();
  for (const wait of waits) {
    if (wait.from >= to) break;
    if (wait.to <= from) continue;
    const ms = coveredWithin(measured, Math.max(wait.from, from), Math.min(wait.to, to));
    if (ms <= 0) continue;
    waitedMs += ms;
    count += 1;
    if (wait.open) openMs += ms;
    const own = bySession.get(wait.sessionId) ?? { ms: 0, waits: 0, open: false };
    own.ms += ms;
    own.waits += 1;
    own.open ||= wait.open;
    bySession.set(wait.sessionId, own);
  }
  return {
    total: { waitedMs, openMs, waits: count, measuredMs: coveredWithin(measured, from, to) },
    bySession,
  };
}

/** A period: its total, each local day in it and the sessions that waited longest. */
function periodOf(
  waits: readonly Wait[],
  measured: readonly Span[],
  names: ReadonlyMap<string, string>,
  from: number,
  to: number,
): WaitPeriod {
  const { total, bySession } = totalIn(waits, measured, from, to);
  const days: WaitDay[] = [];
  for (let start = from; start < to;) {
    const end = Math.min(midnightAfter(midnightOf(start), 1), to);
    days.push({
      day: localDay(start),
      from: start,
      to: end,
      ...totalIn(waits, measured, start, end).total,
    });
    start = end;
  }
  if (days.length === 0) {
    days.push({ day: localDay(from), from, to, waitedMs: 0, openMs: 0, waits: 0, measuredMs: 0 });
  }
  const sessions: SessionWaitTotal[] = [...bySession]
    .map(([sessionId, own]) => ({
      sessionId,
      name: names.get(sessionId) ?? sessionId,
      waitedMs: own.ms,
      waits: own.waits,
      open: own.open,
    }))
    .sort((a, b) => b.waitedMs - a.waitedMs || a.name.localeCompare(b.name));
  return {
    from,
    to,
    ...total,
    days,
    sessions: sessions.slice(0, MAX_WAIT_SESSIONS),
    sessionCount: sessions.length,
  };
}

/**
 * How long sessions waited on the person today, from local midnight, and over
 * the last seven days: today and the six local days before it, from midnight.
 * Each is cut into its local days, and names the sessions that waited longest.
 */
export function waitTotals(input: WaitTotalsInput): { today: WaitPeriod; sevenDays: WaitPeriod } {
  const { now, since } = input;
  const gapMs = input.gapMs ?? POLL_GAP_MS;
  // Only what was measured after the history begins and before now counts.
  // The newest stretch reaches the present while polls are still arriving,
  // and Agent Lookout has not started again since.
  const spans = joined(input.measured);
  const newest = spans[spans.length - 1];
  if (
    newest &&
    newest.to < now &&
    now - newest.to <= gapMs &&
    !input.runStarts.some((start) => start > newest.to && start <= now)
  ) {
    newest.to = now;
  }
  const measured = spans
    .map((span) => ({ from: Math.max(span.from, since), to: Math.min(span.to, now) }))
    .filter((span) => span.to > span.from);
  const { waits, names } = waitsOf(input);
  const today = midnightOf(now);
  const weekStart = midnightAfter(today, -(WAIT_DAYS - 1));
  return {
    today: periodOf(waits, measured, names, today, now),
    sevenDays: periodOf(waits, measured, names, weekStart, now),
  };
}
