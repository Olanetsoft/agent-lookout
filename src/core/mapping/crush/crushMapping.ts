// How Crush's sessions map onto the session model. Pure, so the collector today
// and a browser or desktop host later share one mapping.
//
// A row of Crush's `sessions` table has no field that says a session is
// running, waiting, over or failed, and none that names a process, so all there
// is to go on is whether any Crush program runs. This was worked out from
// Crush's source at v0.99.0, not checked on a computer running it. See
// docs/adapters/crush.md.

import type { SessionStatus } from "../../sessions/session.ts";

/**
 * A session's status, from whether Crush may have it open: a Crush program runs,
 * or whether one does is not known.
 *
 * | Crush may have it open | Status   |
 * | ---------------------- | -------- |
 * | yes                    | unknown  |
 * | no                     | finished |
 *
 * It is never `working`, `idle` or `needs-you`. Nothing ties a session to a
 * process, so one that a crash left behind reads the same as one in a turn while
 * Crush runs in another project.
 */
export function mapCrushStatus(open: boolean): SessionStatus {
  return open ? "unknown" : "finished";
}
