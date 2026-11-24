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
// A wait whose session left every listing counts up to the last poll that
// listed it, and the time after that counts only if a later poll lists the
// session and its wait has not ended.
//
// Codex and Gemini CLI sessions never show as needing the person, so they never
// count here, and Antigravity CLI sessions count only while agy asks for
// approval of a tool.

import type { SessionWaitTotal, WaitDay, WaitPeriod } from "../api.ts";
import { isStatusEvent, type SessionEvent } from "../sessions/session.ts";
import { coveredWithin, joined, POLL_GAP_MS, type Span } from "./measured.ts";
import type { WaitSighting } from "./waitSightings.ts";

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

/** A start of Agent Lookout. */
export interface RunStart {
  kind: "start";
  at: number;
}

/** What waits are worked out from: a start, a session's move, or how a session in a wait was seen. */
export type WaitMark = RunStart | SessionEvent | WaitSighting;

const isStart = (mark: WaitMark): mark is RunStart => "kind" in mark && mark.kind === "start";

/** Whether a mark says how a session in a wait was seen. */
export const isSighting = (mark: WaitMark): mark is WaitSighting => "way" in mark;

/**
 * The move into needs-you of each session whose last wait the marks, in the
 * order they were added, hold no end for. Any event after such a move is a move
 * out of needs-you, so it is the session's newest event of all, and says what
 * it was last doing.
 */
export function unendedWaits(marks: readonly WaitMark[]): SessionEvent[] {
  const newest = new Map<string, SessionEvent>();
  for (const mark of marks) {
    if (isStart(mark) || isSighting(mark) || !isWaitEvent(mark)) continue;
    newest.set(mark.sessionId, mark);
  }
  return [...newest.values()].filter((event) => event.kind !== "ended" && event.to === "needs-you");
}

export interface WaitTotalsInput {
  /**
   * The starts, the events into and out of needs-you and the sightings the
   * history holds, in the order they were added. Not by their times, which go
   * back when the clock is set back. Other events are passed over.
   */
  marks: readonly WaitMark[];
  /** The stretches Agent Lookout measured, in any order. */
  measured: readonly Span[];
  /** The sessions that need the person now, as the latest poll found them. */
  waitingNow: readonly { id: string; name: string }[];
  /**
   * The name of every session the latest poll found, waiting or not. A session
   * is named by it first, then by its newest event or sighting.
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

/** A wait with no end yet, as the history is gone through. */
interface Standing {
  from: number;
  /** The last poll that listed its session, while a sighting says it was lost. */
  lost?: number;
  /** The start of the first run since its newest mark. */
  nextRun?: number;
  /** Whether a sighting is of it. A file from before there were any has none. */
  sighted?: boolean;
  /** Whether a sighting found it, with no event to say it began. */
  found?: boolean;
}

/**
 * Every wait the history holds, oldest first: a move into needs-you, to the
 * session's next move out of it. A wait that was already under way when the
 * history first saw the session, such as one Agent Lookout found as it
 * started, is counted from the first poll that listed it. A wait with no end
 * runs to the present, and is open while the session still needs the person.
 *
 * Each run writes a sighting of a wait at the first poll that lists its
 * session. So a wait is known up to the start of the run after the last that
 * saw it, whether an end is seen later or not: its source may not have been
 * read since. A wait no event began ends there for good when a whole run has
 * not seen it: no event would say that run found it over. A file from before
 * there were sightings says nothing of the runs that saw a wait. One that ends
 * in it runs to that end, and one that began unseen counts from that run's
 * start, or the session's previous event when that is later.
 *
 * A wait whose session left every listing stops at the last poll that listed
 * it (`WaitSighting`), whether or not an end is seen later. An end seen once
 * the session is back says only that the wait ended somewhere in the time
 * nobody saw it, which is not counted. A session listed again with its wait not
 * ended is taken to have stood through that time, so it is one wait from when
 * it began, and nothing is lost. But a status time later than where it was last
 * known (`began`) shows the wait ended unseen: it stops there, and a new wait
 * starts at that time.
 *
 * A wait that ends at an earlier time than it began, as when the clock is set
 * back in it, counts as no time.
 */
export function waitsOf(input: WaitTotalsInput): { waits: Wait[]; names: Map<string, string> } {
  const { now, since } = input;
  const waits: Wait[] = [];
  const names = new Map<string, string>();
  const standing = new Map<string, Standing>();
  /** Each session's newest move into needs-you or out of it. */
  const moved = new Map<string, number>();
  let run = since;
  /** A wait nothing says when it began: from this run's start, or from the session's previous event. */
  const unbegun = (id: string): Standing => ({ from: Math.max(run, moved.get(id) ?? run) });
  const close = (sessionId: string, { from }: Standing, to: number, open = false) => {
    waits.push({ sessionId, from, to, open });
    standing.delete(sessionId);
  };
  /** The wait a session stands in, unless no event began it and a whole run has not seen it. */
  const standingIn = (id: string) => {
    const wait = standing.get(id);
    if (!wait?.found || wait.nextRun === undefined || wait.nextRun === run) return wait;
    close(id, wait, wait.lost ?? wait.nextRun);
    return undefined;
  };

  for (const mark of input.marks) {
    if (isStart(mark)) {
      run = mark.at;
      for (const wait of standing.values()) wait.nextRun ??= run;
      continue;
    }
    if (!isSighting(mark) && !isWaitEvent(mark)) continue;
    const { sessionId, at } = mark;
    names.set(sessionId, mark.sessionName);
    let wait = standingIn(sessionId);
    const gone = wait?.lost ?? wait?.nextRun;
    if (isSighting(mark)) {
      if (!wait) {
        const from = mark.lastSeen === undefined ? at : unbegun(sessionId).from;
        wait = { from, found: true };
      } else if (mark.began !== undefined && mark.lastSeen === undefined && gone !== undefined) {
        // One that says it was lost repeats the cut its wait began with.
        waits.push({ sessionId, from: wait.from, to: gone, open: false });
        wait.from = mark.began;
      }
      // An earlier version says a wait lost by this run's first poll was seen
      // up to this run, whichever run last saw it.
      const lost = mark.lastSeen && Math.min(mark.lastSeen, wait.nextRun ?? mark.lastSeen);
      standing.set(sessionId, { ...wait, lost, nextRun: undefined, sighted: true });
      continue;
    }
    if (mark.kind !== "ended" && mark.to === "needs-you") {
      // It waits anew, so the wait an earlier run saw ended unseen.
      if (wait?.nextRun !== undefined) close(sessionId, wait, gone ?? wait.nextRun);
      if (!standing.has(sessionId)) standing.set(sessionId, { from: at });
    } else {
      wait ??= unbegun(sessionId);
      close(sessionId, wait, (wait.sighted ? gone : mark.lastSeen) ?? at);
    }
    moved.set(sessionId, at);
  }
  for (const [sessionId, name] of input.names ?? []) names.set(sessionId, name);
  for (const { id, name } of input.waitingNow) {
    names.set(id, name);
    close(id, standingIn(id) ?? unbegun(id), now, true);
  }
  for (const [id, wait] of standing) close(id, wait, wait.lost ?? wait.nextRun ?? now);

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
    !input.marks.some((mark) => isStart(mark) && mark.at > newest.to && mark.at <= now)
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
