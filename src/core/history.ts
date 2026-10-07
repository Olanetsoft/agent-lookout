import type { HistoryResponse, HistorySince } from "./api.ts";
import type { HistoryPoint, Session } from "./sessions/session.ts";
import { needsYou as needsThePerson } from "./waits/answeredWaits.ts";

/** The default window the dashboard charts: the last 15 minutes. */
export const DEFAULT_HISTORY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Counts one poll's sessions into a history point. A stale session is idle, but
 * it is counted on its own and not as idle, as the dashboard's counts have it,
 * so the Idle chart's line ends at the Idle count's figure. A session in a
 * wait Agent Lookout answered is done waiting (`answeredWaits.ts`), so it is
 * not counted as needing the person, and is counted as working, as the
 * page's counts have it, so the Working chart's line ends at the Working
 * count's figure. So a prompt a rule answered is never in the history as a
 * wait, as it is never in Waits.
 */
export function historyPointFor(sessions: readonly Session[], at: number): HistoryPoint {
  let needsYou = 0;
  let working = 0;
  let idle = 0;
  for (const session of sessions) {
    if (needsThePerson(session)) needsYou += 1;
    else if (session.status === "working" || session.status === "needs-you") working += 1;
    else if (session.status === "idle" && !session.stale) idle += 1;
  }
  return { at, needsYou, working, idle, total: sessions.length };
}

/**
 * Where the history an answer of `/api/history` holds begins: its `since`, or,
 * from a collector that does not say, the moment it started watching.
 */
export function historySince(history: Pick<HistoryResponse, "startedAt" | "since">): HistorySince {
  return history.since ?? { at: history.startedAt, by: "started" };
}
