// How OpenCode 2's sessions map onto the session model. Pure, like
// `opencodeMapping.ts`, which maps the sessions OpenCode 1.x writes.
//
// OpenCode 2 keeps each session's turn on its row of `session_v2`, in the same
// `opencode.db`. `time_suspended` is its claim, set as a turn starts and
// cleared as the turn succeeds, fails or is stopped. `time_idle` and
// `idle_outcome` are set as a turn ends. A turn cut off when the service shuts
// down or crashes keeps its claim until the service starts again and resumes
// it. Waits for an answer or an approval are in the service's memory alone, and
// nothing marks a session closed, since one background service owns every
// session. So a session is never "needs-you" here. This was built from
// OpenCode's source at v2.2.5, and has not yet been checked on a computer
// running OpenCode. See docs/adapters/opencode.md for where each value comes
// from.

import type { SessionStatus } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";

/** What `idle_outcome` holds once a turn has ended. */
export const SUCCEEDED_OUTCOME = "succeeded";
export const FAILED_OUTCOME = "failed";
export const INTERRUPTED_OUTCOME = "interrupted";

/**
 * How a turn stands in a row of `session_v2`. Each field is as it was read, so
 * one of the wrong type makes the status unknown rather than a guess.
 */
export interface Opencode2TurnFields {
  /** `time_suspended`, in epoch milliseconds: set while a turn holds its claim on the session. Null when none does. */
  claimedAt: unknown;
  /** `time_idle`, in epoch milliseconds: when the newest turn ended. Null before one has. */
  idleAt: unknown;
  /** `idle_outcome`: `succeeded`, `failed` or `interrupted`. Null before a turn has ended. */
  outcome: unknown;
}

export interface Opencode2StatusFields {
  turn: Opencode2TurnFields;
  /**
   * Whether OpenCode may have the session open: an OpenCode program runs, or
   * whether one does is not known. While it is not, every session is
   * finished, unless it failed or cannot be read.
   */
  open: boolean;
}

const isTime = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);

/** What the row says while OpenCode may have the session open, or `unknown`. */
function openStatus({ claimedAt, idleAt, outcome }: Opencode2TurnFields): SessionStatus {
  if (claimedAt !== null && !isTime(claimedAt)) return "unknown";
  // A turn holds its claim, so `idle_outcome` is of the turn before it.
  if (claimedAt !== null) return "working";
  if (idleAt !== null && !isTime(idleAt)) return "unknown";
  if (outcome === null || outcome === SUCCEEDED_OUTCOME || outcome === INTERRUPTED_OUTCOME) {
    return "idle";
  }
  return outcome === FAILED_OUTCOME ? "failed" : "unknown";
}

/**
 * Maps a row of `session_v2`, and whether OpenCode may have it open, to a
 * status.
 *
 * | `time_suspended`        | `idle_outcome`             | Open    | Closed   |
 * | ----------------------- | -------------------------- | ------- | -------- |
 * | set                     | any                        | working | finished |
 * | none                    | none                       | idle    | finished |
 * | none                    | `succeeded`, `interrupted` | idle    | finished |
 * | none                    | `failed`                   | failed  | failed   |
 * | none                    | any other                  | unknown | unknown  |
 * | of the wrong type       | any                        | unknown | unknown  |
 * | none, and `time_idle` of the wrong type | any        | unknown | unknown  |
 *
 * A session a turn was cut off in is finished once OpenCode is closed, and
 * working once it runs again, which resumes the turn. A session that failed,
 * or cannot be read, stays so once OpenCode is closed. A wait for the person
 * is in memory alone, so a session in one shows as working. A command the
 * person runs with `!` takes no claim, so with no turn running it does not show
 * as working: the row stays idle, or failed if the last turn failed.
 */
export function mapOpencode2Status(fields: Opencode2StatusFields): SessionStatus {
  const open = openStatus(fields.turn);
  if (open === "failed" || open === "unknown") return open;
  return fields.open ? open : "finished";
}

export interface Opencode2Times {
  turn: Opencode2TurnFields;
  /** The newest time OpenCode wrote anything of the session. */
  activityAt: number | null;
}

/**
 * When the session's status began, as far as its row says. A time that could
 * not be right is not known.
 *
 * - working: when the turn took its claim, which does not move when a turn cut
 *   off is resumed.
 * - idle, failed and finished: when the newest turn ended, unless one holds its
 *   claim, as one cut off does, so that `time_idle` is older than the turn;
 *   else the newest time anything of the session was written.
 * - unknown: not known.
 */
export function opencode2StatusSince(
  status: SessionStatus,
  { turn, activityAt }: Opencode2Times,
  now: number,
): number | null {
  if (status === "unknown") return null;
  if (status === "working") return plausibleTime(turn.claimedAt, now);
  const ended = turn.claimedAt === null ? plausibleTime(turn.idleAt, now) : null;
  return ended ?? plausibleTime(activityAt, now);
}
