// How Goose's sessions map onto the session model. Pure, so the collector today
// and a browser or desktop host later share one mapping.
//
// A row of Goose's `sessions` table has no field that says a session is
// running, waiting, over or failed, and none that names a process, so all there
// is to go on is whether any Goose program runs. This was worked out from
// Goose's source at v1.57.0, not checked on a computer running it. See
// docs/adapters/goose.md.

import type { SessionStatus } from "../../sessions/session.ts";

/**
 * A session's status, from whether Goose may have it open: a Goose program runs,
 * or whether one does is not known.
 *
 * | Goose may have it open | Status   |
 * | ---------------------- | -------- |
 * | yes                    | unknown  |
 * | no                     | finished |
 *
 * It is never `working`, `idle` or `needs-you`. Nothing ties a session to a
 * process, so one that a crash left behind reads the same as one in a turn while
 * another Goose runs.
 */
export function mapGooseStatus(open: boolean): SessionStatus {
  return open ? "unknown" : "finished";
}
