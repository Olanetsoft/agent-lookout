/**
 * How long each session has waited on the person, over the period the page can
 * vouch for: the bars of waits in the hero, and the last wait that is over for
 * the hero's quiet state.
 *
 * It is built on the timeline, so it follows the timeline's rules for what was
 * measured: a wait is counted where the timeline draws it, and time nobody
 * measured is counted out and reported, never guessed at.
 *
 * The period is as long as what the page holds allows. It starts at the latest
 * of when Agent Lookout started, the start of the hour of history the page
 * keeps, and, once the event log is full, the oldest event in it. It is called
 * "today" only when it reaches back to local midnight, and is then cut there.
 */

import type { HistoryResponse } from "@core/api";
import type { Session, SessionEvent } from "@core/sessions/session";
import { formatClockMinutes, formatDuration, startOfDay } from "@dashboard/lib/format";
import {
  lengthOf,
  measuredSpans,
  pollRuns,
  uncovered,
  type Span,
} from "@dashboard/lib/charts/measured";
import { DEFAULT_GAP_MS } from "@dashboard/lib/charts/sparkline";
import { buildTimeline, TIMELINE_WINDOW_MS } from "@dashboard/lib/charts/timeline";

/** What decided where the period starts. */
export type PeriodBound = "started" | "held" | "events" | "midnight";

export interface Period {
  from: number;
  /** The present. */
  to: number;
  bound: PeriodBound;
  /** True when the period reaches back to local midnight, and starts there. */
  today: boolean;
}

export interface SessionWaits {
  /** The session's id. */
  id: string;
  name: string;
  /** How long it waited on the person in the period, in all. */
  ms: number;
  /**
   * How many times it waited. A wait that runs on across time nobody measured
   * is one wait, since nothing was seen to answer it.
   */
  times: number;
  /** Whether one of its waits is still open: it needs the person now. */
  open: boolean;
  /**
   * False when a wait was already under way when the period began, or began
   * while nothing was measuring, so the length is a minimum.
   */
  startKnown: boolean;
}

export interface LastWait {
  /** The session's id. */
  id: string;
  name: string;
  /** How long it lasted, or, when its start is not known, how long it lasted in the period. */
  ms: number;
  /**
   * False when the wait was already under way when the period began, as when
   * Agent Lookout started while the session waited, so `ms` is a minimum.
   */
  startKnown: boolean;
  /** When it was over. */
  at: number;
  /** Answered: the session went on. Ended: the session finished, failed or left. */
  how: "answered" | "ended";
}

export interface WaitedOnYou {
  period: Period;
  /** Every session that waited in the period, longest first. */
  sessions: SessionWaits[];
  /** All of their waits added up. */
  totalMs: number;
  /** The stretches of the period nobody measured, up to the last answer, oldest first. */
  gaps: Span[];
  /** How long they last in all. */
  unmeasuredMs: number;
  /** The wait in the period that was over most recently, or null when none was. */
  lastWait: LastWait | null;
}

export interface WaitsInput {
  sessions: readonly Session[];
  /** Every event the page holds, in any order. */
  events: readonly SessionEvent[];
  /** The history the page holds. Without it nothing can be vouched for. */
  history: HistoryResponse | null;
  /** The present. */
  now: number;
  /** The last answer. Nothing after it was measured. */
  asOf?: number;
  /** Set when the page holds as many events as it can, so older ones may be gone. */
  eventsFull?: boolean;
  /** How much history the page keeps. */
  heldMs?: number;
  gapMs?: number;
}

/** Where the period starts, and what decided it. */
function periodOf(input: WaitsInput, history: HistoryResponse): Period {
  const { now, events } = input;
  const heldMs = input.heldMs ?? TIMELINE_WINDOW_MS;
  let oldestPoint = Infinity;
  for (const point of history.points) if (point.at < oldestPoint) oldestPoint = point.at;
  let oldestEvent = Infinity;
  for (const event of events) if (event.at < oldestEvent) oldestEvent = event.at;

  const candidates: [number, PeriodBound][] = [
    [history.startedAt, "started"],
    [Math.max(oldestPoint === Infinity ? now : oldestPoint, now - heldMs), "held"],
  ];
  if (input.eventsFull && oldestEvent !== Infinity) candidates.push([oldestEvent, "events"]);

  let [from, bound] = candidates[0] as [number, PeriodBound];
  for (const [at, why] of candidates) {
    if (at > from) [from, bound] = [at, why];
  }
  from = Math.min(from, now);

  const midnight = startOfDay(now);
  if (from <= midnight) return { from: midnight, to: now, bound: "midnight", today: true };
  return { from, to: now, bound, today: false };
}

/**
 * The wait that was over most recently in the period, from the events: a move
 * into needs-you, then the next thing that session did. A session whose first
 * event the page holds moves it out of needs-you was waiting before that: when
 * Agent Lookout started while it waited, say. Its wait is offered from the
 * start of the period, as the bars count it, with its start marked not known.
 */
function lastWaitOver(events: readonly SessionEvent[], period: Period, until: number) {
  const bySession = new Map<string, SessionEvent[]>();
  for (const event of events) {
    const own = bySession.get(event.sessionId);
    if (own) own.push(event);
    else bySession.set(event.sessionId, [event]);
  }

  let last: LastWait | null = null;
  for (const own of bySession.values()) {
    own.sort((a, b) => a.at - b.at);
    own.forEach((event, index) => {
      const began = own[index - 1];
      const waited = began ? began.to === "needs-you" : event.from === "needs-you";
      if (!waited || event.to === "needs-you") return;
      if (event.at < period.from || event.at > until) return;
      if (began && event.at <= began.at) return;
      if (last && event.at <= last.at) return;
      const ended = event.kind === "ended" || event.to === "finished" || event.to === "failed";
      last = {
        id: event.sessionId,
        name: event.sessionName,
        ms: event.at - (began ? began.at : period.from),
        startKnown: began !== undefined,
        at: event.at,
        how: ended ? "ended" : "answered",
      };
    });
  }
  return last as LastWait | null;
}

/**
 * Every session's waits over the period, longest first, with the time nobody
 * measured and the last wait that is over. Null when there is no history to
 * vouch for any of it.
 */
export function waitedOnYou(input: WaitsInput): WaitedOnYou | null {
  const { history, now } = input;
  if (!history) return null;
  const gapMs = input.gapMs ?? DEFAULT_GAP_MS;
  const until = Math.min(input.asOf ?? now, now);
  const period = periodOf(input, history);

  const timeline = buildTimeline({
    sessions: input.sessions,
    events: input.events,
    history,
    now,
    asOf: until,
    eventsFull: input.eventsFull,
    windowMs: now - period.from,
    gapMs,
  });

  const sessions: SessionWaits[] = [];
  for (const row of timeline.rows) {
    let ms = 0;
    let times = 0;
    let open = false;
    let startKnown = true;
    // Whether the last stretch that was measured was a wait, with the session
    // running ever since.
    let waiting = false;
    let reached = -Infinity;
    for (const segment of row.segments) {
      if (segment.from > reached) waiting = false;
      reached = segment.to;
      if (segment.kind === "unmeasured") continue;
      if (segment.kind !== "needs-you") {
        waiting = false;
        continue;
      }
      if (!waiting) times += 1;
      waiting = true;
      ms += segment.to - segment.from;
      if (segment.open) open = true;
      if (segment.startKnown === false) startKnown = false;
    }
    if (ms > 0) sessions.push({ id: row.id, name: row.name, ms, times, open, startKnown });
  }
  sessions.sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));

  // Breaks are counted up to the last answer. After it, the page says above
  // everything that it has stopped updating, and the waits stop there too.
  const window: Span = { from: period.from, to: Math.max(period.from, until) };
  const measured = measuredSpans(
    pollRuns(history, until, gapMs),
    window,
    until,
    history.startedAt,
    gapMs,
  );
  const gaps = uncovered(measured, window);

  return {
    period,
    sessions,
    totalMs: sessions.reduce((sum, session) => sum + session.ms, 0),
    gaps,
    unmeasuredMs: lengthOf(gaps),
    lastWait: lastWaitOver(input.events, period, until),
  };
}

/** "Waited on you today", or "since 09:15" when the period does not reach back to midnight. */
export function waitedHeading(waits: WaitedOnYou): string {
  return waits.period.today
    ? "Waited on you today"
    : `Waited on you since ${formatClockMinutes(waits.period.from)}`;
}

/**
 * What the bars cover and what they leave out, in one plain sentence:
 * "Measured since 09:15, with 2m 30s not measured after 09:40."
 */
export function measuredNote(waits: WaitedOnYou): string {
  const since = `Measured since ${formatClockMinutes(waits.period.from)}`;
  const lost = unmeasuredNote(waits);
  return lost ? `${since}, with ${lost}.` : `${since}.`;
}

/**
 * How much of the period nobody measured, as a fragment, or null when all of it
 * was: "2m 30s not measured after 09:40", or "in 2 breaks, the first after 09:40".
 */
export function unmeasuredNote(waits: WaitedOnYou): string | null {
  const first = waits.gaps[0];
  if (!first || waits.unmeasuredMs <= 0) return null;
  const lost = formatDuration(waits.unmeasuredMs);
  if (waits.gaps.length === 1) {
    return `${lost} not measured after ${formatClockMinutes(first.from)}`;
  }
  return `${lost} not measured in ${waits.gaps.length} breaks, the first after ${formatClockMinutes(first.from)}`;
}
