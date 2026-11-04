// How Cline's session manifests map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// Cline's runtime keeps one manifest for each session, and writes the session's
// status into it each time the status changes. This mapping reads what the
// manifest says and whether the process it names runs, and was worked out from
// the source of Cline's CLI at cli-v3.0.74, not checked on a computer running
// it. See docs/adapters/cline.md.

import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";

/** The statuses of a session that is open: its process has to run for them to hold. */
const OPEN_STATUSES = new Set(["running", "pending", "idle"]);

/** Whether a manifest's status says the session is open, so its process is worth asking about. */
export function isOpenClineStatus(status: string | null): boolean {
  return status !== null && OPEN_STATUSES.has(status);
}

export interface ClineStatusFields {
  /** `status` as the manifest has it, or null when it has none that is text. */
  status: string | null;
  /**
   * Whether the session's own process runs: false when it has gone, or another
   * program was given its pid. Null when nothing can be asked, as for a manifest
   * with no pid, and when nothing was asked, as for a session that has ended.
   */
  processRuns: boolean | null;
}

export interface ClineStatus {
  status: SessionStatus;
  waitingReason?: WaitingReason;
}

/**
 * Maps what a manifest says, and whether its process runs, to a session status.
 * The rows are taken in this order:
 *
 * | `status`                     | Its process | Status    |
 * | ---------------------------- | ----------- | --------- |
 * | `completed` or `cancelled`   | any         | finished  |
 * | `failed`                     | any         | failed    |
 * | `running`                    | runs        | working   |
 * | `pending`                    | runs        | needs-you |
 * | `idle`                       | runs        | idle      |
 * | `running`, `pending`, `idle` | gone        | finished  |
 * | `running`, `pending`, `idle` | not known   | unknown   |
 * | anything else                | any         | unknown   |
 *
 * `pending` is written by one thing at cli-v3.0.74: the wrapper around a tool's
 * approval, for as long as the approval is asked (`local-runtime-host.ts:957-978`).
 * So its reason is `permission`. A crash writes nothing, so a manifest can say
 * `running` long after its process ended: a status that needs a process counts
 * only while the process runs, and a manifest that names none is not guessed at.
 */
export function mapClineStatus({ status, processRuns }: ClineStatusFields): ClineStatus {
  if (status === "completed" || status === "cancelled") return { status: "finished" };
  if (status === "failed") return { status: "failed" };
  if (!isOpenClineStatus(status) || processRuns === null) return { status: "unknown" };
  if (!processRuns) return { status: "finished" };
  if (status === "running") return { status: "working" };
  if (status === "pending") return { status: "needs-you", waitingReason: "permission" };
  return { status: "idle" };
}
