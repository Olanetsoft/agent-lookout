/**
 * The rows of the timeline: each session's status over the last hour, built from
 * what the page already holds. The snapshot says what every session is doing
 * now, the events say when each one changed, and the history says when the
 * collector was measuring at all.
 *
 * On a row, time is one of three things:
 *
 *   a status       the collector was polling, and this is what it saw
 *   not measured   the session was there, as far as anyone knows, but nothing
 *                  was polling: before Agent Lookout started, across a break in
 *                  its polls, or since the page stopped getting answers
 *   empty          the session was not running: it had not started, or had ended
 *
 * Time that was not measured is never filled in with a status, with one
 * exception. A source reports when a session's present status began, so that
 * status may reach back to that moment over time nobody polled.
 *
 * Nor is a status known before Agent Lookout last started, for a session the
 * page holds no event of: that it has not changed is known only for as long
 * as this run has watched it. Before that its row is not measured, though
 * something was polling, unless its source says when its status began.
 *
 * "Not measured" is worked out row by row, so each row is hatched only where its
 * own status is not known. A row whose status its source vouches for has no
 * hatch there, though nothing was polling, and time before anything is known of
 * a session, such as before it first appeared, stays not measured.
 */

import type { HistoryResponse } from "@core/api";
import { historySince } from "@core/history";
import {
  isStatusEvent,
  type Session,
  type SessionEvent,
  type SessionStatus,
} from "@core/sessions/session";
import { STALE_THRESHOLD_MS } from "@core/sessions/staleness";
import type { TrackSegment } from "@dashboard/components/ui/charts/StatusTrack";
import { measuredSpans, pollRuns, uncovered, type Span } from "@dashboard/lib/charts/measured";
import { groupSessions } from "@dashboard/lib/sessions/sessions";
import { DEFAULT_GAP_MS } from "@dashboard/lib/charts/sparkline";

/** The timeline covers the last hour. */
export const TIMELINE_WINDOW_MS = 60 * 60 * 1000;

export interface TimelineRow {
  /** The session's id. */
  id: string;
  name: string;
  /** True for a session that ended inside the window and is no longer listed. */
  ended: boolean;
  /** What a listed session is doing now. Null for one that has left the list. */
  status: SessionStatus | null;
  /** Whether a listed session is stale now. */
  stale: boolean;
  /** In time order, never overlapping. Time with no segment is time it was not running. */
  segments: TrackSegment[];
}

export interface Timeline {
  /** Left edge of the window, epoch milliseconds. */
  start: number;
  /** Right edge of the window: the present. */
  end: number;
  rows: TimelineRow[];
  /** The stretches of the window nobody measured, oldest first. */
  unmeasured: Span[];
}

export interface TimelineInput {
  /** The sessions in the latest snapshot. */
  sessions: readonly Session[];
  /** Every event the page holds, in any order. */
  events: readonly SessionEvent[];
  /** One point per poll over the window, oldest first, and when the collector began. */
  history: HistoryResponse | null;
  /** The present. The window ends here. */
  now: number;
  /**
   * The moment the snapshot describes: the present while answers arrive, and the
   * last answer once they stop. Nothing after it was measured.
   */
  asOf?: number;
  /**
   * Set when the page holds as many events as it can. Older ones may have been
   * dropped, so nothing before the oldest one held can be vouched for.
   */
  eventsFull?: boolean;
  windowMs?: number;
  /** Two polls further apart than this were not measuring in between. */
  gapMs?: number;
  /**
   * How long a session is idle before it is stale, as the snapshot's time
   * rules say: where a stale session's idle line turns to dots. Defaults to a day.
   */
  staleAfterMs?: number;
}

/**
 * A stretch of one session's life with one status, before measurement is taken
 * into account. "unseen" is a stretch in which nothing is known of the session
 * yet: it may have started, but no poll had seen it. Where something was polling
 * it was not there, so only the time nobody polled is left not measured.
 */
interface Piece extends Span {
  status: SessionStatus | "unseen";
  /** Whether `from` is a moment something reported, not just as far back as is known. */
  startObserved: boolean;
  /** The present status, back to when its source says it began. Drawn over unmeasured time. */
  reaches: boolean;
  /** Its status is not known, though it was running: drawn as not measured, polled or not. */
  notKnown?: true;
}

/**
 * One session's events, oldest first, as stretches of status. `runStart` is
 * when this run of Agent Lookout began.
 */
function statusPieces(
  session: Session | undefined,
  events: readonly SessionEvent[],
  window: Span,
  until: number,
  gapMs: number,
  runStart: number,
): Piece[] {
  const pieces: Piece[] = [];
  const startedAt = session?.startedAt ?? null;
  const first = events[0];

  if (first) {
    // A start time later than the first event is of a later run of the session.
    const before = startedAt !== null && startedAt < first.at ? startedAt : -Infinity;
    if (first.kind !== "appeared") {
      // It was already there, doing what the event says it changed from.
      pieces.push({
        from: before,
        to: first.at,
        status: first.from ?? "unknown",
        startObserved: before !== -Infinity,
        reaches: false,
      });
    } else {
      // It appeared then. Back to its start time, or with none as far back as
      // the window goes, it was not there wherever something was polling, and
      // nothing is known of it wherever nothing was.
      pieces.push({
        from: before,
        to: first.at,
        status: "unseen",
        startObserved: before !== -Infinity,
        reaches: false,
      });
    }
    events.forEach((event, index) => {
      const previous = events[index - 1];
      if (event.kind === "appeared" && previous?.kind === "ended" && event.at > previous.at) {
        // Back after it ended: nothing is known of it in between either.
        pieces.push({
          from: previous.at,
          to: event.at,
          status: "unseen",
          startObserved: true,
          reaches: false,
        });
      }
      const to = events[index + 1]?.at ?? window.to;
      if (event.kind === "ended" || to <= event.at) return;
      pieces.push({
        from: event.at,
        to,
        status: event.to ?? "unknown",
        startObserved: true,
        reaches: false,
      });
    });
  } else if (session) {
    // No event means no change: it has had its present status for as long as
    // anyone was looking. That is since this run began: a session found as it
    // was when Agent Lookout started again is not known to have been doing
    // the same before, unless its source says when its status began.
    const began = startedAt ?? -Infinity;
    const from = Math.max(began, Math.min(runStart, session.statusSince ?? Infinity));
    if (from > began) {
      pieces.push({
        from: began,
        to: from,
        status: "unknown",
        startObserved: startedAt !== null,
        reaches: false,
        notKnown: true,
      });
    }
    pieces.push({
      from,
      to: window.to,
      status: session.status,
      startObserved: from !== -Infinity,
      reaches: false,
    });
  }

  if (!session) return pieces;

  // A listed session is running now, and the snapshot says what it is doing,
  // whatever the newest event held says.
  let current = pieces[pieces.length - 1];
  if (!current || current.to !== window.to || current.status === "unseen") {
    current = {
      from: events[events.length - 1]?.at ?? -Infinity,
      to: window.to,
      status: session.status,
      startObserved: true,
      reaches: false,
    };
    pieces.push(current);
  }
  current.status = session.status;

  const since = session.statusSince;
  if (since !== null && since < until) {
    if (since > current.from + gapMs) {
      // The source says the status began after the page last saw it change. What
      // was seen before that stands, and the reported stretch starts where the
      // source says.
      current.to = since;
      current = {
        from: since,
        to: window.to,
        status: session.status,
        startObserved: true,
        reaches: true,
      };
      pieces.push(current);
    } else {
      // Never further back than the event that brought the status about.
      current.reaches = true;
    }
  }

  // Once answers stop, the status is known up to the last one and no further.
  if (until < window.to && current.from < until) {
    current.to = until;
    pieces.push({
      from: until,
      to: window.to,
      status: session.status,
      startObserved: true,
      reaches: false,
    });
  }
  return pieces;
}

/** Lays one session's pieces over the time that was measured. */
function segmentsFor(
  pieces: readonly Piece[],
  measured: readonly Span[],
  runs: readonly Span[],
  window: Span,
): TrackSegment[] {
  const segments: TrackSegment[] = [];
  /** Whether a poll just before this moment saw what came before it. */
  const watched = (at: number) => runs.some((run) => run.from < at && at <= run.to);

  const unmeasured = (from: number, to: number, piece: Piece) => {
    if (to <= from) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "unmeasured" && last.to === from) {
      last.to = to;
      return;
    }
    // Cut off by the edge of the window, it began some time before.
    const startKnown = !(from === window.from && piece.from < from);
    segments.push({ from, to, kind: "unmeasured", startKnown });
  };

  for (const piece of pieces) {
    const from = Math.max(piece.from, window.from);
    const to = Math.min(piece.to, window.to);
    if (to <= from) continue;

    if (piece.notKnown) {
      unmeasured(from, to, piece);
      continue;
    }
    if (piece.reaches && piece.status !== "unseen") {
      const startKnown = piece.startObserved && from === piece.from;
      segments.push({ from, to, kind: piece.status, startKnown });
      continue;
    }

    let cursor = from;
    for (const span of measured) {
      if (span.to <= cursor) continue;
      if (span.from >= to) break;
      const a = Math.max(span.from, cursor);
      const b = Math.min(span.to, to);
      unmeasured(cursor, a, piece);
      if (piece.status !== "unseen" && b > a) {
        // A change found by the first poll after a break happened some time
        // during the break, so its start is not known either.
        const startKnown = piece.startObserved && a === piece.from && watched(a);
        segments.push({ from: a, to: b, kind: piece.status, startKnown });
      }
      cursor = b;
    }
    unmeasured(cursor, to, piece);
  }
  return segments;
}

/**
 * A stale session's idle stretch, split where it became stale: idle up to the
 * stale threshold after its status began, stale from there on. An earlier idle
 * stretch ended before the present one began, so it is never touched.
 */
function splitStale(segments: readonly TrackSegment[], staleFrom: number): TrackSegment[] {
  return segments.flatMap((segment): TrackSegment[] => {
    if (segment.kind !== "idle" || segment.to <= staleFrom) return [segment];
    if (segment.from >= staleFrom) return [{ ...segment, kind: "stale" }];
    return [
      { ...segment, to: staleFrom },
      { ...segment, from: staleFrom, kind: "stale", startKnown: true },
    ];
  });
}

function byTime(a: SessionEvent, b: SessionEvent): number {
  return a.at - b.at;
}

/**
 * The timeline for the last hour.
 *
 * Rows are the sessions in the snapshot, in the order of the Sessions list,
 * followed by the sessions that ended inside the window, most recently ended
 * first. An ended session is known only from its events, so it is named from them.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const { sessions, events, history, now } = input;
  const gapMs = input.gapMs ?? DEFAULT_GAP_MS;
  const window: Span = { from: now - (input.windowMs ?? TIMELINE_WINDOW_MS), to: now };
  const until = Math.min(input.asOf ?? now, now);

  const eventsBySession = new Map<string, SessionEvent[]>();
  let oldestEvent = Infinity;
  for (const event of events) {
    if (event.at < oldestEvent) oldestEvent = event.at;
    // A row is drawn from what the events say of the status. Being stopped
    // says nothing of it: the session's leaving the list is an event of its own.
    if (!isStatusEvent(event)) continue;
    const own = eventsBySession.get(event.sessionId);
    if (own) own.push(event);
    else eventsBySession.set(event.sessionId, [event]);
  }
  for (const own of eventsBySession.values()) own.sort(byTime);

  const runs = pollRuns(history, until, gapMs);
  const vouchFrom = Math.max(
    history ? historySince(history).at : -Infinity,
    input.eventsFull && oldestEvent !== Infinity ? oldestEvent : -Infinity,
  );
  const measured = measuredSpans(runs, window, until, vouchFrom, gapMs);

  const rowFor = (id: string, name: string, session: Session | undefined): TimelineRow => {
    const pieces = statusPieces(
      session,
      eventsBySession.get(id) ?? [],
      window,
      until,
      gapMs,
      history?.startedAt ?? -Infinity,
    );
    let segments = segmentsFor(pieces, measured, runs, window);
    if (session?.stale && session.status === "idle" && session.statusSince !== null) {
      segments = splitStale(
        segments,
        session.statusSince + (input.staleAfterMs ?? STALE_THRESHOLD_MS),
      );
    }
    const last = segments[segments.length - 1];
    // Whatever a listed session's row ends on at the present has not ended.
    if (session && last && last.to === window.to) last.ongoing = true;
    // The wait the latest answer shows is open: at the present while answers
    // arrive. Once they stop it is cut where they stopped, not answered, so it is
    // still open as far as anyone knows, though it no longer reaches the present.
    if (session?.status === "needs-you") {
      for (const segment of segments) {
        if (segment.kind === "needs-you" && segment.to === until) segment.open = true;
      }
    }
    return {
      id,
      name,
      ended: session === undefined,
      status: session?.status ?? null,
      stale: session?.stale ?? false,
      segments,
    };
  };

  const listed = groupSessions(sessions).flatMap((group) => group.sessions);
  const rows = listed.map((session) => rowFor(session.id, session.name, session));

  const listedIds = new Set(listed.map((session) => session.id));
  const ended: { at: number; row: TimelineRow }[] = [];
  for (const [id, own] of eventsBySession) {
    const last = own[own.length - 1];
    if (!last || listedIds.has(id) || last.kind !== "ended" || last.at <= window.from) continue;
    ended.push({ at: last.at, row: rowFor(id, last.sessionName, undefined) });
  }
  ended.sort((a, b) => b.at - a.at || a.row.name.localeCompare(b.row.name));

  return {
    start: window.from,
    end: window.to,
    rows: [...rows, ...ended.map((item) => item.row)],
    unmeasured: uncovered(measured, window),
  };
}
