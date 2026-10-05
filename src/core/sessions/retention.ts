import type { Session } from "./session.ts";

/**
 * How long a finished or failed session whose process has gone stays on the
 * dashboard: 24 hours. After that it is old news and is left out.
 */
export const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Whether a session is over for good: finished or failed, with no process left behind it. */
export function isOver(session: Pick<Session, "status" | "alive">): boolean {
  return (session.status === "finished" || session.status === "failed") && session.alive !== true;
}

/**
 * Whether a session that has been over since `overSince` should still be shown.
 * A clock that has stepped backwards never hides anything.
 */
export function isWithinRetention(
  overSince: number,
  now: number,
  retentionMs: number = FINISHED_RETENTION_MS,
): boolean {
  return now - overSince < retentionMs;
}
