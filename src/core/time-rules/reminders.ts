import type { Session, SessionsSnapshot } from "../sessions/session.ts";
import { needsYou } from "../waits/answeredWaits.ts";

/**
 * When a long wait's reminder is due, by one rule every channel shares: the
 * page's notifications, the collector's own, email and the webhook.
 *
 * A wait is reminded of once it has lasted the threshold, if the channel saw
 * it before it had lasted that long, and only once for that threshold. So a
 * wait already older than the threshold when a page opened, or when Agent
 * Lookout started, is not reminded of out of the blue, and a page and the
 * collector, reading the same snapshots, come to the same reminder at the same
 * poll. Set a longer threshold while a wait is under way, and it is reminded of
 * again once it lasts that long. Set a shorter one, and a wait seen when it was
 * younger than that is reminded of at the next poll.
 *
 * A wait is one stretch of "needs-you" that began at one time: its status
 * time, or, for a source that gives none, the moment it was first seen. The
 * reminder says how long it has waited, measured from then. A wait Agent
 * Lookout answered is over from the answer, so none comes in the moment
 * before its source says so (`needsYou` in `answeredWaits.ts`).
 */

/** A reminder that is due. */
export interface DueReminder {
  /** The session as it is now, waiting. */
  session: Session;
  /** When the wait began. */
  begunAt: number;
  /** How long it has waited, at the moment the reminder is due. */
  waitedMs: number;
}

/** One wait being watched. */
interface Watched {
  begunAt: number;
  /** How long it had waited when it was first seen. */
  firstSeenAfterMs: number;
  /** The thresholds it has been reminded at, in milliseconds. */
  reminded: Set<number>;
}

export interface ReminderWatch {
  /**
   * Takes each snapshot, with the ids of the sessions whose wait ended at it,
   * as `sessionChanges` gives them: those are forgotten, and every wait it
   * shows that is not being watched yet is, from now.
   */
  observe(snapshot: SessionsSnapshot, stopped: readonly string[], at: number): void;
  /**
   * The reminders due at `at` for a threshold, in the snapshot's order:
   * longest wait first. `eligible` leaves out the waits a channel has not yet
   * told of, as email and the webhook do for a wait still within their delay.
   */
  due(
    snapshot: SessionsSnapshot,
    at: number,
    thresholdMs: number,
    eligible?: (sessionId: string) => boolean,
  ): DueReminder[];
  /** Notes that a session's wait was reminded of at this threshold. */
  reminded(sessionId: string, thresholdMs: number): void;
  /**
   * Notes that a wait was first told of only now, as one held through quiet
   * hours is when they end, or one an email sends once its delay has passed.
   * If it has lasted the threshold already, what was told says so, and no
   * reminder follows straight after.
   */
  toldLate(sessionId: string, at: number, thresholdMs: number): void;
  /** Forgets every wait, as when a page finds Agent Lookout was started again. */
  clear(): void;
}

/** Whether a source's answer could be read, so what it shows of its sessions counts. */
function readable(snapshot: SessionsSnapshot): Set<string> {
  return new Set(
    snapshot.sources
      .filter((source) => source.state === "ok" || source.state === "not-set-up")
      .map((source) => source.id),
  );
}

export function createReminderWatch(): ReminderWatch {
  const watched = new Map<string, Watched>();

  return {
    observe(snapshot, stopped, at) {
      for (const id of stopped) watched.delete(id);
      const sources = readable(snapshot);
      for (const session of snapshot.sessions) {
        if (!needsYou(session) || !sources.has(session.source)) continue;
        const since =
          session.statusSince !== null && session.statusSince <= at ? session.statusSince : null;
        const known = watched.get(session.id);
        // A wait whose source gives no time keeps the moment it was first seen.
        if (known && (since === null || since === known.begunAt)) continue;
        watched.set(session.id, {
          begunAt: since ?? at,
          firstSeenAfterMs: since === null ? 0 : at - since,
          reminded: new Set(),
        });
      }
    },

    due(snapshot, at, thresholdMs, eligible = () => true) {
      const found: DueReminder[] = [];
      for (const session of snapshot.sessions) {
        if (!needsYou(session)) continue;
        const wait = watched.get(session.id);
        if (!wait || wait.reminded.has(thresholdMs) || !eligible(session.id)) continue;
        const waitedMs = at - wait.begunAt;
        if (waitedMs < thresholdMs || wait.firstSeenAfterMs >= thresholdMs) continue;
        found.push({ session, begunAt: wait.begunAt, waitedMs });
      }
      return found;
    },

    reminded(sessionId, thresholdMs) {
      watched.get(sessionId)?.reminded.add(thresholdMs);
    },

    toldLate(sessionId, at, thresholdMs) {
      const wait = watched.get(sessionId);
      if (wait && at - wait.begunAt >= thresholdMs) wait.reminded.add(thresholdMs);
    },

    clear() {
      watched.clear();
    },
  };
}
