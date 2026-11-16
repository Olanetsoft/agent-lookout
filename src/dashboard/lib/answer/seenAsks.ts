import type { Session } from "@core/sessions/session";
import { inAnsweredWait } from "@core/waits/answeredWaits";

/**
 * The permission requests the page has seen, by session: for each session
 * still in the wait for permission it saw a request in, the last request it
 * saw, when the collector lets that one go, and which wait it was.
 *
 * A request leaves the snapshot the moment it is answered, by a press here,
 * in the details over the hero, in another tab, in the Mac app's menu bar or
 * on its notification, while the session still reads as waiting in that
 * wait until the collector's next poll marks it `answered`. A wait with no
 * request held is then one whose request was answered a moment ago, not one
 * whose request never came. So while a request was seen for the wait and its
 * hold has not run out, nothing says why the wait has no Deny or Allow
 * (`noAsk.ts`).
 *
 * The store that reads the snapshot keeps it, poll by poll, so the hero and
 * the details go by the same memory, however often a row is drawn afresh. It
 * holds no word of what was asked. It is lost when the page is reloaded, and
 * the store starts it again when the collector restarts, since the run before
 * let every request it held go as it stopped, and once history is first read
 * after it was kept, since the run it was kept in is not known.
 */

export interface SeenAsk {
  /** Agent Lookout's own id for the request, or null for one the page could not read. */
  requestId: string | null;
  /**
   * When the collector lets it go, on its clock, in epoch milliseconds, or
   * null for a request the page could not read: then nothing is said for the
   * rest of the wait.
   */
  until: number | null;
  /** The status time of the wait it was seen in, or null while the session's source gave none. */
  statusSince: number | null;
}

/** By session id. */
export type SeenAsks = ReadonlyMap<string, SeenAsk>;

/** None seen yet. */
export const NO_ASKS_SEEN: SeenAsks = new Map();

/**
 * What is remembered once a snapshot has been read: the request each session
 * has now, and the one seen before for each session still in the same wait.
 * A session that has left the list, stopped waiting for permission, or waits
 * since another time is in another wait, and its request is forgotten. A time
 * that either side does not know says nothing about the wait, as in
 * `inAnsweredWait`, and a time the source gives only once a request was seen
 * is taken as that wait's, so the next wait is told from it.
 */
export function rememberAsks(seen: SeenAsks, sessions: readonly Session[]): SeenAsks {
  const kept = new Map<string, SeenAsk>();
  for (const session of sessions) {
    const { statusSince } = session;
    if (session.ask !== undefined) {
      const { requestId, until } = session.ask;
      kept.set(session.id, { requestId, until, statusSince });
      continue;
    }
    if (session.askNotRead === true) {
      kept.set(session.id, { requestId: null, until: null, statusSince });
      continue;
    }
    const before = seen.get(session.id);
    if (before === undefined || !inAnsweredWait(session, { since: before.statusSince })) continue;
    kept.set(session.id, before.statusSince === null ? { ...before, statusSince } : before);
  }
  return kept;
}
