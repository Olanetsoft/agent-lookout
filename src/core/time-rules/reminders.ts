import type { Session, SessionsSnapshot } from "../sessions/session.ts";
import { needsYou } from "../waits/answeredWaits.ts";
import type { LongWaitRule } from "./timeRules.ts";

/**
 * When a long wait's reminder is due, by one rule every channel shares: the
 * page's notifications, the collector's own, email, the webhook, ntfy and
 * Pushover.
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
 * With the repeat on, a wait still open is reminded of again each time the
 * repeat's minutes pass after the threshold: at 10 minutes, then 40, 70 and so
 * on, for a threshold of 10 and a repeat of 30. The moments go by how long the
 * wait has lasted, never by when a channel last sent one, so every channel
 * comes to the same repeat at the same poll, and one held back, as through
 * quiet hours or by an email's hourly limit, does not move the next. Only one
 * reminder of a wait is ever due at a time: after a gap, as when the computer
 * slept, one goes for the latest moment passed, and none for those before it.
 * A repeat never comes within half the repeat's minutes of the last reminder
 * told, so one that went late, as when quiet hours end, is not followed by
 * another a minute after it: that moment is passed over, and the next goes. A
 * wait first seen past the threshold, as after Agent Lookout started again,
 * has no reminder for the moments it had passed already, and its next comes
 * at the next moment.
 *
 * A wait is one stretch of "needs-you" that began at one time: its status
 * time, or, for a source that gives none, the moment it was first seen. The
 * reminder says how long it has waited, measured from then. A wait Agent
 * Lookout answered is over from the answer, so none comes in the moment
 * before its source says so (`needsYou` in `answeredWaits.ts`).
 */

/** When a wait's reminders come, as the long wait rule says. */
export interface ReminderSchedule {
  /** How long a wait lasts before its first reminder, in milliseconds. */
  thresholdMs: number;
  /** How long after that each next one comes, in milliseconds, or null when it does not repeat. */
  everyMs: number | null;
}

const MINUTE_MS = 60_000;

/** The schedule the long wait rule sets. */
export function reminderSchedule(rule: LongWaitRule): ReminderSchedule {
  return {
    thresholdMs: rule.minutes * MINUTE_MS,
    everyMs: rule.repeat?.on ? rule.repeat.minutes * MINUTE_MS : null,
  };
}

/**
 * Which moment of the schedule a wait this long has passed last: -1 before the
 * threshold, 0 from it, and with the repeat on, 1 once the repeat's minutes
 * have passed after it, 2 after twice that, and so on.
 */
export function reminderNumber(waitedMs: number, schedule: ReminderSchedule): number {
  if (waitedMs < schedule.thresholdMs) return -1;
  if (schedule.everyMs === null) return 0;
  return Math.floor((waitedMs - schedule.thresholdMs) / schedule.everyMs);
}

/** A reminder that is due. */
export interface DueReminder {
  /** The session as it is now, waiting. */
  session: Session;
  /** When the wait began. */
  begunAt: number;
  /** How long it has waited, at the moment the reminder is due. */
  waitedMs: number;
  /**
   * Which moment of the schedule it is for, by `reminderNumber`: 0 for the
   * first, at the threshold, and from 1 a repeat.
   */
  repeat: number;
}

/** One wait being watched. */
interface Watched {
  begunAt: number;
  /** How long it had waited when it was first seen. No reminder is due for a moment it had passed by then. */
  seenAfterMs: number;
  /**
   * How long it had waited when it was last told of, by a reminder or by its
   * own notice, or null while it has not been. No reminder is due for a moment
   * it had passed by then, nor a repeat for a moment within half the repeat's
   * minutes after it.
   */
  toldAfterMs: number | null;
}

export interface ReminderWatch {
  /**
   * Takes each snapshot, with the ids of the sessions whose wait ended at it,
   * as `sessionChanges` gives them: those are forgotten, and every wait it
   * shows that is not being watched yet is, from now.
   */
  observe(snapshot: SessionsSnapshot, stopped: readonly string[], at: number): void;
  /**
   * The reminders due at `at` by a schedule, in the snapshot's order: longest
   * wait first, one at most for each wait. `eligible` leaves out the waits a
   * channel has not yet told of, as email, the webhook and pushes do for a
   * wait still within their delay.
   */
  due(
    snapshot: SessionsSnapshot,
    at: number,
    schedule: ReminderSchedule,
    eligible?: (sessionId: string) => boolean,
  ): DueReminder[];
  /**
   * Notes that a session's wait was told of at `at`, by a reminder, or by its
   * own notice once it is first told of only now, as one held through quiet
   * hours is when they end, or one an email sends once its delay has passed.
   * What was told says how long it has waited, so no reminder is due until
   * the schedule's next moment after it.
   */
  told(sessionId: string, at: number): void;
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
          seenAfterMs: since === null ? 0 : at - since,
          toldAfterMs: null,
        });
      }
    },

    due(snapshot, at, schedule, eligible = () => true) {
      const found: DueReminder[] = [];
      for (const session of snapshot.sessions) {
        if (!needsYou(session)) continue;
        const wait = watched.get(session.id);
        if (!wait || !eligible(session.id)) continue;
        const waitedMs = at - wait.begunAt;
        const repeat = reminderNumber(waitedMs, schedule);
        // By the schedule in force now, so a threshold or a repeat changed
        // while the wait goes on counts from what was last told, and never
        // brings the moments before it.
        if (repeat < 0 || repeat <= reminderNumber(wait.seenAfterMs, schedule)) continue;
        const told = wait.toldAfterMs;
        if (told !== null && repeat <= reminderNumber(told, schedule)) continue;
        const { thresholdMs, everyMs } = schedule;
        // A moment too soon after a reminder that went late is passed over.
        if (told !== null && everyMs !== null && repeat > 0) {
          if (thresholdMs + repeat * everyMs - told < everyMs / 2) continue;
        }
        found.push({ session, begunAt: wait.begunAt, waitedMs, repeat });
      }
      return found;
    },

    told(sessionId, at) {
      const wait = watched.get(sessionId);
      if (wait) wait.toldAfterMs = Math.max(wait.toldAfterMs ?? 0, at - wait.begunAt);
    },

    clear() {
      watched.clear();
    },
  };
}
