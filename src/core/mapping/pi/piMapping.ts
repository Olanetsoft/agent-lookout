// How Pi's sessions map onto the session model. Pure, so the collector today and
// a browser or desktop host later share one mapping.
//
// A Pi session file has no field that says a session is running, waiting or
// over, and none that names a process, so all there is to go on is whether any
// `pi` program runs. This was worked out from Pi's source at v1.5.0, not checked
// on a computer running it. See docs/adapters/pi.md.

import type { SessionStatus } from "../../sessions/session.ts";

/**
 * A session's status, from whether Pi may have it open: a `pi` program runs, or
 * whether one does is not known.
 *
 * | Pi may have it open | Status   |
 * | ------------------- | -------- |
 * | yes                 | unknown  |
 * | no                  | finished |
 *
 * It is never `working`, `idle` or `needs-you`. Nothing ties a session to a
 * process, so one that a crash left behind reads the same as one in a turn while
 * another `pi` runs.
 */
export function mapPiStatus(open: boolean): SessionStatus {
  return open ? "unknown" : "finished";
}
