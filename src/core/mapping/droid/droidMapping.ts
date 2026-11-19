// How Droid's sessions map onto the session model. Pure, so the collector today
// and a browser or desktop host later share one mapping.
//
// A Droid session's file has no field that says a session is running, waiting,
// over or failed, and none that names a process, so all there is to go on is
// whether any `droid` program runs. This was worked out from Factory's
// documentation and its Droid SDKs, droid-sdk 0.5.0 and @factory/droid-sdk
// 0.11.0, not from Droid's own program, and not checked on a computer running
// Droid. See docs/adapters/droid.md.

import type { SessionStatus } from "../../sessions/session.ts";

/**
 * A session's status, from whether Droid may have it open: a `droid` program
 * runs, whether one does is not known, or a session was written too near the
 * last answer of `ps` for that answer to tell.
 *
 * | Droid may have it open | Status   |
 * | ---------------------- | -------- |
 * | yes                    | unknown  |
 * | no                     | finished |
 *
 * It is never `working`, `idle`, `needs-you` or `failed`. Nothing ties a
 * session to a process, so one that a crash left behind reads the same as one
 * in a turn while another `droid` runs.
 */
export function mapDroidStatus(open: boolean): SessionStatus {
  return open ? "unknown" : "finished";
}
