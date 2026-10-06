import type { EventKind, EventSeverity, Session, SessionEvent, SessionStatus } from "./session.ts";

/**
 * How loudly a status deserves to be announced: arriving at "needs-you" is a
 * warning, arriving at "failed" is critical, and everything else is advisory.
 */
export function severityFor(to: SessionStatus | undefined): EventSeverity {
  if (to === "needs-you") return "warning";
  if (to === "failed") return "critical";
  return "advisory";
}

function eventId(sessionId: string, at: number, kind: EventKind): string {
  return `${sessionId}@${at}:${kind}`;
}

/**
 * Compares two polls of the same source and describes what changed.
 *
 * - A session in `next` that was not in `previous` has appeared.
 * - A session in both whose status differs has changed status.
 * - A session in `previous` that is not in `next` has ended.
 *
 * Nothing else is an event: a new name, a new waiting reason or a new status
 * time on the same status is not reported.
 *
 * The caller decides what counts as `previous`. The first poll has nothing to
 * compare against and should not be diffed at all, because the sessions already
 * running when the collector started did not appear at that moment.
 */
export function diffSessions(
  previous: readonly Pick<Session, "id" | "name" | "status">[],
  next: readonly Pick<Session, "id" | "name" | "status">[],
  at: number,
): SessionEvent[] {
  const before = new Map(previous.map((session) => [session.id, session]));
  const after = new Set(next.map((session) => session.id));
  const events: SessionEvent[] = [];

  for (const session of next) {
    const old = before.get(session.id);
    if (!old) {
      events.push({
        id: eventId(session.id, at, "appeared"),
        at,
        sessionId: session.id,
        sessionName: session.name,
        kind: "appeared",
        to: session.status,
        severity: severityFor(session.status),
      });
    } else if (old.status !== session.status) {
      events.push({
        id: eventId(session.id, at, "status-changed"),
        at,
        sessionId: session.id,
        sessionName: session.name,
        kind: "status-changed",
        from: old.status,
        to: session.status,
        severity: severityFor(session.status),
      });
    }
  }

  for (const session of previous) {
    if (after.has(session.id)) continue;
    events.push({
      id: eventId(session.id, at, "ended"),
      at,
      sessionId: session.id,
      sessionName: session.name,
      kind: "ended",
      from: session.status,
      severity: "advisory",
    });
  }

  return events;
}

/**
 * What the event log has said so far: the last reported status of every session
 * it considers present. A session it has reported as ended is not in the map.
 */
export type ReportedStatuses = Map<string, SessionStatus>;

/**
 * Passes a diff through what has already been reported, so nothing is said twice.
 *
 * A source can be read in more than one way, each with its own previous poll to
 * compare against. A change that happened while one way was in use shows up
 * again when the other way is next compared with its own, older, previous poll.
 * This drops the events the log already holds and corrects `from` on the rest,
 * so the log reads as one story:
 *
 * - "appeared" for a session already present is dropped, or becomes a status
 *   change when the status is news.
 * - "status-changed" to the status already reported is dropped.
 * - "ended" for a session already reported as ended, or never present, is dropped.
 *
 * `reported` is updated to match what is returned.
 */
export function withoutRepeats(
  events: readonly SessionEvent[],
  reported: ReportedStatuses,
): SessionEvent[] {
  const fresh: SessionEvent[] = [];
  for (const event of events) {
    const said = reported.get(event.sessionId);

    if (event.kind === "ended") {
      if (said === undefined) continue;
      reported.delete(event.sessionId);
      fresh.push({ ...event, from: said });
      continue;
    }

    const to = event.to;
    if (to === undefined || said === to) continue;
    reported.set(event.sessionId, to);
    if (said === undefined) {
      fresh.push(event);
    } else {
      fresh.push({
        ...event,
        id: eventId(event.sessionId, event.at, "status-changed"),
        kind: "status-changed",
        from: said,
      });
    }
  }
  return fresh;
}
