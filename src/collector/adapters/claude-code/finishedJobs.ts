import {
  FINISHED_RETENTION_MS,
  isOver,
  isWithinRetention,
} from "../../../core/sessions/retention.ts";
import type { Session } from "../../../core/sessions/session.ts";

/**
 * Ages out background sessions that are over.
 *
 * `claude agents --json --all` lists finished and failed background sessions
 * for as long as Claude Code remembers them, and it does not say when each one
 * ended. Shown without a limit they would bury the sessions that are running.
 * So a session that is over stays on the dashboard for the retention period and
 * is then left out.
 *
 * The period is counted from the moment this collector first saw the session
 * over. A session that was already over when the collector started has no such
 * moment, so its start time stands in: the only time the feed gives, and never
 * later than the real ending. That errs towards leaving old news out. A job that
 * ran for more than the retention period and ended before the collector started
 * is not shown.
 */
export interface FinishedTracker {
  /**
   * Returns the sessions to show. Call it once per poll, with all of that
   * poll's sessions, and only for a poll that has an answer from the feed. A
   * poll without one cannot see the jobs that are over: given to this, it would
   * be taken to mean they had gone, and their period would start again when
   * the feed next answered.
   */
  keepRecent(sessions: readonly Session[], now: number): Session[];
}

export function createFinishedTracker(
  retentionMs: number = FINISHED_RETENTION_MS,
): FinishedTracker {
  /** By session id: the time each session that is over is counted from. */
  const overSince = new Map<string, number>();
  let hasPolled = false;

  return {
    keepRecent(sessions, now) {
      const kept: Session[] = [];
      const over = new Set<string>();

      for (const session of sessions) {
        if (!isOver(session)) {
          kept.push(session);
          continue;
        }
        over.add(session.id);
        let since = overSince.get(session.id);
        if (since === undefined) {
          since = hasPolled ? now : (session.startedAt ?? now);
          overSince.set(session.id, since);
        }
        if (isWithinRetention(since, now, retentionMs)) kept.push(session);
      }

      // A session that is no longer listed, or is running again, starts afresh.
      for (const id of overSince.keys()) {
        if (!over.has(id)) overSince.delete(id);
      }
      hasPolled = true;
      return kept;
    },
  };
}
