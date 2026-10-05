// How a status file's words map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping. The format is
// Agent Lookout's own, described in docs/GUIDE.md under "Your own agents".

import type { Session, SessionStatus, WaitingReason } from "../sessions/session.ts";

const STATUS = new Map<string, SessionStatus>([
  ["working", "working"],
  ["waiting", "needs-you"],
  ["idle", "idle"],
  ["finished", "finished"],
  ["failed", "failed"],
]);

const REASON = new Map<string, WaitingReason>([
  ["permission", "permission"],
  ["question", "question"],
]);

/** The two fields of a status file that say what the session is doing. */
export interface StatusFileStatusFields {
  /** `working`, `waiting`, `idle`, `finished` or `failed`. */
  status: unknown;
  /** For `waiting` only: `permission` or `question`. */
  reason?: unknown;
}

/**
 * Maps a status file's `status` and `reason` to a session status.
 *
 * | status     | Session status |
 * | ---------- | -------------- |
 * | `working`  | working        |
 * | `waiting`  | needs-you      |
 * | `idle`     | idle           |
 * | `finished` | finished       |
 * | `failed`   | failed         |
 *
 * Any other status becomes "unknown" rather than a guess, so a file written
 * for a later version still shows. A waiting session's reason is `permission`
 * or `question` when the file says so, and "other" for anything else or
 * nothing. A reason is kept only while waiting.
 */
export function mapStatusFileStatus(
  fields: StatusFileStatusFields,
): Pick<Session, "status" | "waitingReason"> {
  const status = (typeof fields.status === "string" && STATUS.get(fields.status)) || "unknown";
  if (status !== "needs-you") return { status };
  const reason = typeof fields.reason === "string" ? REASON.get(fields.reason) : undefined;
  return { status, waitingReason: reason ?? "other" };
}
