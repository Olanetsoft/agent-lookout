import type { Session, SessionsSnapshot, SourceId } from "./session.ts";

/**
 * What is remembered from one snapshot to the next: for each source that has
 * answered, its sessions that needed the person at its last "ok" answer, by id.
 * Each is kept with the latest status time its wait has been seen with, or null
 * while its source has given none. A source that has never answered "ok" is
 * absent, which is how its first answer is told from a later one.
 */
export type WaitMemory = ReadonlyMap<SourceId, ReadonlyMap<string, number | null>>;

/** The memory to start from, before any snapshot has been seen. */
export const EMPTY_WAIT_MEMORY: WaitMemory = new Map();

export interface WaitChanges {
  /** What to hand back with the next snapshot. */
  memory: WaitMemory;
  /** The sessions that began waiting for the person, in the snapshot's order. */
  started: Session[];
  /**
   * The ids of the sessions whose wait ended. A session that has begun another
   * wait since is in `started` as well: what was shown for the wait that ended
   * is taken down first, and the new wait is announced after it.
   */
  stopped: string[];
}

/** The later of two status times. Null is a time nobody gave, and is never the later. */
function laterOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

/**
 * Compares a snapshot with what was remembered from the one before, and says
 * which sessions began waiting for the person and which stopped. It decides
 * which change of status deserves a notification and which notification to
 * clear, and nothing about how either is done.
 *
 * A wait is one stretch of "needs-you" that began at one time: the status time
 * its source gives it.
 *
 * - Only a source that is "ok" in this snapshot is compared. One that is
 *   searching, unavailable, in error or not listed could not be read, so what
 *   is remembered of it is kept as it is and nothing is said about its
 *   sessions. A source that fails for one poll does not end every wait and
 *   start them all again.
 * - A source's first "ok" answer is a baseline. The sessions waiting in it were
 *   already waiting; they did not begin at this moment, so none has started.
 * - After that, a session that needs the person and is not remembered has
 *   started. A remembered one that is now in any other status, or gone from
 *   the list, has stopped.
 * - A remembered session that still needs the person, with a status time later
 *   than any its wait has been seen with, has stopped and started. Sources are
 *   read every couple of seconds. A session that is answered, works for a
 *   moment and asks again inside that time is never seen in another status,
 *   and its status time is all that tells the second wait from the first.
 * - Any other session that goes on waiting is neither, whatever happens to its
 *   reason, its detail or its name. A status time that is missing, the same or
 *   earlier is not a later one. A source that cannot say when a status began
 *   gives null, which says nothing about the wait, so the last time that was
 *   given is the one kept.
 *
 * The fourth rule takes a source at its word that `statusSince` moves only when
 * a status begins, which is what the session model asks of it. Claude Code's
 * registry has been seen to keep one status time for as long as a status
 * stands; the field notes are in the adapter's `registry.ts`. Whether it gives
 * a new time when only the reason for waiting changes is not known. If it does,
 * that is announced as a new wait, with the new reason. A source added later
 * must not give a waiting session a time that moves while the session goes on
 * waiting, or every move would be announced.
 *
 * Neither argument is changed. Called again with the memory it returned and
 * the same snapshot, it reports nothing.
 */
export function waitChanges(memory: WaitMemory, snapshot: SessionsSnapshot): WaitChanges {
  const waitingNow = new Map<SourceId, Map<string, number | null>>();
  for (const source of snapshot.sources) {
    if (source.state === "ok") waitingNow.set(source.id, new Map());
  }

  const started: Session[] = [];
  const stopped: string[] = [];
  for (const session of snapshot.sessions) {
    if (session.status !== "needs-you") continue;
    const waiting = waitingNow.get(session.source);
    // No map means the source did not answer. An id already in it was counted.
    if (!waiting || waiting.has(session.id)) continue;

    const remembered = memory.get(session.source);
    if (!remembered?.has(session.id)) {
      // Not remembered. In a source's first answer that is the baseline, and
      // after it the session has started.
      if (remembered) started.push(session);
      waiting.set(session.id, session.statusSince);
      continue;
    }

    const seen = remembered.get(session.id) ?? null;
    const since = session.statusSince;
    if (seen !== null && since !== null && since > seen) {
      // The wait that was remembered ended and this one began, unseen.
      stopped.push(session.id);
      started.push(session);
    }
    waiting.set(session.id, laterOf(seen, since));
  }

  const next = new Map(memory);
  for (const [source, waiting] of waitingNow) {
    for (const id of memory.get(source)?.keys() ?? []) {
      if (!waiting.has(id)) stopped.push(id);
    }
    next.set(source, waiting);
  }

  return { memory: next, started, stopped };
}
