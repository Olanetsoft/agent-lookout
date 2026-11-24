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
   * for one an earlier run still listed, when the run after that began.
   */
  lastSeen?: number;
  /**
   * Present when a session out of sight was listed waiting again with a status
   * time later than the last poll that listed it: that time. The wait it was
   * lost in ended unseen, and this one began then.
   */
  began?: number;
}
