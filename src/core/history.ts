import type { HistoryPoint, Session } from "./session.ts";

/** The default window the dashboard charts: the last 15 minutes. */
export const DEFAULT_HISTORY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Counts one poll's sessions into a history point. A stale session is idle, but
 * it is counted on its own and not as idle, as the dashboard's tiles count it,
 * so the Idle tile's line ends at the Idle tile's figure.
 */
export function historyPointFor(sessions: readonly Session[], at: number): HistoryPoint {
  let needsYou = 0;
  let working = 0;
  let idle = 0;
  for (const session of sessions) {
    if (session.status === "needs-you") needsYou += 1;
    else if (session.status === "working") working += 1;
    else if (session.status === "idle" && !session.stale) idle += 1;
  }
  return { at, needsYou, working, idle, total: sessions.length };
}
