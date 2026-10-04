import type { Session } from "./session.ts";

/** A session is stale after this long in one unbroken stretch of "idle": 24 hours. */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a session has been idle for the stale threshold or longer.
 *
 * Only a session that is idle now, and whose source reports when it became idle,
 * can be stale. Without that time the answer is "not stale": how long it has
 * been idle was not measured, and start time is no substitute, because a session
 * that started days ago may have been working until a minute ago.
 */
export function isStale(
  session: Pick<Session, "status" | "statusSince">,
  now: number,
  thresholdMs: number = STALE_THRESHOLD_MS,
): boolean {
  if (session.status !== "idle") return false;
  if (session.statusSince === null) return false;
  return now - session.statusSince >= thresholdMs;
}
