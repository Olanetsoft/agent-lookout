import { FINISHED_RETENTION_MS, isWithinRetention } from "../../../core/sessions/retention.ts";
import type { Session } from "../../../core/sessions/session.ts";
import { closedQwenCodeSession } from "./toSession.ts";

/**
 * Keeps the Qwen Code sessions that have closed, for 24 hours.
 *
 * Qwen Code lists only the sessions its processes have open, and keeps no
 * record of one that closed. So a session closes here when a poll no longer
 * finds it open, after an earlier poll did: its record has gone, its process
 * has gone, or its record names another session, as after /clear or /resume.
 * It is then shown as finished from that poll, with what was last known of
 * it, and its chat file is not read again.
 *
 * At the first poll, a record whose process has already gone, as one a crash
 * leaves behind, is shown as finished too, from when its chat file was last
 * written. Every other session that closed before Agent Lookout started is
 * not shown, and what this keeps lives in memory only.
 *
 * A session that is open again, under the same id, leaves this list.
 */
export interface FinishedSessions {
  /**
   * The closed sessions to show beside this poll's open ones. `open` is every
   * session this poll found open. `leftBehind` is the records whose process
   * had gone, made into sessions, and is used only at the first poll. A poll
   * that could not read the list of running sessions is not given to this:
   * the poll before it stands.
   */
  update(open: readonly Session[], leftBehind: readonly Session[], now: number): Session[];
  /** True until the first poll has been given. */
  readonly first: boolean;
}

export function createFinishedSessions(
  retentionMs: number = FINISHED_RETENTION_MS,
): FinishedSessions {
  /** The sessions the last poll found open, by id. */
  let wasOpen = new Map<string, Session>();
  /** The closed sessions, by id. */
  const closed = new Map<string, Session>();
  let first = true;

  return {
    get first() {
      return first;
    },
    update(open, leftBehind, now) {
      const openIds = new Set(open.map((session) => session.id));
      for (const [id, session] of wasOpen) {
        if (!openIds.has(id) && !closed.has(id))
          closed.set(id, closedQwenCodeSession(session, now));
      }
      if (first) {
        for (const session of leftBehind) {
          if (!openIds.has(session.id) && !closed.has(session.id)) closed.set(session.id, session);
        }
      }
      for (const [id, session] of closed) {
        const since = session.statusSince;
        if (openIds.has(id) || since === null || !isWithinRetention(since, now, retentionMs)) {
          closed.delete(id);
        }
      }
      wasOpen = new Map(open.map((session) => [session.id, session]));
      first = false;
      return [...closed.values()];
    },
  };
}
