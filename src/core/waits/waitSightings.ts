// How the poller last saw each session in a wait, for what works out how long
// a wait stood. A session can leave every listing with nothing to show that its
// wait ended, as when its agent closes and a way of reading that does not list
// it takes over. Absence proves nothing, since a fallback can leave out a
// session that still waits, so the log says nothing and the wait stays open in
// it. A sighting says where the sight of it was lost, and is kept with the
// history. It is never shown in the Events log or sent anywhere. Pure, with no
// Node API.

/** A change in how a session in a wait is seen: listed by a way that was not listing it, or left out. */
export interface WaitSighting {
  sessionId: string;
  /** The session's name, as its events name it. */
  sessionName: string;
  /** The poll that found this. */
  at: number;
  /** The way of reading that last listed the session, as `readWays` keys it. */
  way: string;
  /**
   * Present when a poll left the session out: the last poll that listed it, or
   * for one the last run still listed, when this run began.
   */
  lastSeen?: number;
  /**
   * Present when a session out of sight was listed waiting again with a status
   * time later than the last poll that listed it: that time. The wait it was
   * lost in ended unseen, and this one began then.
   */
  began?: number;
}

/** Each session's sightings, oldest first. */
export function sightingsBySession(
  sightings: readonly WaitSighting[],
): Map<string, WaitSighting[]> {
  const bySession = new Map<string, WaitSighting[]>();
  for (const sighting of [...sightings].sort((a, b) => a.at - b.at)) {
    const own = bySession.get(sighting.sessionId);
    if (own) own.push(sighting);
    else bySession.set(sighting.sessionId, [sighting]);
  }
  return bySession;
}

/**
 * Where a wait from `from` up to `until` lost sight of a session and never saw
 * it again, or null when it did not: the `lastSeen` of its newest sighting.
 * `own` is oldest first.
 */
export function lastSeenWithin(
  own: readonly WaitSighting[],
  from: number,
  until: number,
): number | null {
  let lastSeen: number | null = null;
  for (const sighting of own) {
    if (sighting.at >= from && sighting.at < until) lastSeen = sighting.lastSeen ?? null;
  }
  return lastSeen;
}

/**
 * A stretch of waiting from `from` to `to`, cut wherever a sighting says a
 * wait ended unseen and a new one began (`began`): up to the last poll that
 * listed the session, then from that status time. Oldest first, and one
 * stretch when nothing cut it. `own` is oldest first.
 */
export function waitStretches(
  own: readonly WaitSighting[],
  from: number,
  to: number,
): { from: number; to: number }[] {
  const stretches: { from: number; to: number }[] = [];
  let start = from;
  let lastSeen: number | null = null;
  for (const sighting of own) {
    if (sighting.at < start || sighting.at > to) continue;
    if (sighting.lastSeen !== undefined) {
      lastSeen = sighting.lastSeen;
    } else if (sighting.began !== undefined && lastSeen !== null) {
      stretches.push({ from: start, to: lastSeen });
      start = sighting.began;
      lastSeen = null;
    }
  }
  stretches.push({ from: start, to });
  return stretches;
}
