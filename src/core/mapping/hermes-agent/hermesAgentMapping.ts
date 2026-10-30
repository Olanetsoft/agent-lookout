// How Hermes Agent's conversations map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// Hermes Agent keeps every session of a profile in one SQLite database,
// `state.db`. A turn holds a lease on its conversation while it runs, a
// pending `clarify` question is a tool call of that turn with no result yet,
// and the gateway labels a session that waits for an approval. Hermes stamps a
// session it ends, and closes a failed turn with a row of its own. This was built from Hermes
// Agent's source at v0.22.5 and has not yet been checked on a computer running
// Hermes Agent. See docs/adapters/hermes-agent.md for where each value comes
// from.

import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";

/** `display_kind` of the row Hermes Agent closes a failed turn with (`agent/turn_failure_copy.py`). */
export const FAILED_TURN_KIND = "failed_turn";

/** The `finish_reason` values Hermes Agent counts as errors (`hermes_state_sessions.py`). */
export const FAILED_FINISH_REASONS: readonly string[] = ["error", "agent_error", "content_filter"];

/**
 * The roles a conversation's newest row can have. `session_meta` and `system`
 * rows are passed over before it is chosen, as Hermes Agent's own
 * `latest_conversation_role` does.
 */
export const HERMES_AGENT_ROLES: readonly string[] = ["user", "assistant", "tool"];

/** The newest conversation row of a session, with each field as it was read, times in milliseconds. */
export interface HermesAgentNewestRow {
  /** `role`: `user`, `assistant` or `tool`. */
  role: unknown;
  /** `display_kind`, such as `failed_turn`, or null. */
  kind: unknown;
  /** `finish_reason`, or null. */
  finish: unknown;
  /** 1 when `display_metadata` holds an `error` key, 0 when it does not, null when it is not JSON. */
  error: unknown;
  /** When it was written. */
  at: unknown;
}

/** The turn lease on the conversation, times in milliseconds. */
export interface HermesAgentLease {
  /** `acquired_at`: when the turn began. A renewal does not change it. */
  at: unknown;
  /** `expires_at`: when the lease runs out unless it is renewed. */
  until: unknown;
}

export interface HermesAgentStatusInput {
  /** The tip's `ended_at`, or null while it is open. */
  endedAt: unknown;
  /** The tip's `end_reason`, or null. */
  endReason: unknown;
  /** The tip's newest conversation row, or null when it has none. */
  newest: HermesAgentNewestRow | null;
  /** How many `clarify` calls of the newest assistant row with tool calls have no result yet. */
  openQuestions: unknown;
  /** How many calls of that row, of any tool, have no result yet. */
  openCalls: unknown;
  /** When the newest assistant row with tool calls was written. */
  callsAt: unknown;
  /** 1 when the tip's activity label says it waits for an approval, else 0, or null for no label. */
  approvalLabel: unknown;
  /** 1 when the tip's activity label says it waits for an answer to a question, else 0, or null for no label. */
  questionLabel: unknown;
  /**
   * When the activity label was saved: the tip's `last_activity_at`, which
   * Hermes Agent writes only together with the label.
   */
  labelAt: unknown;
  /** The root's turn lease, or null when no turn holds one. */
  lease: HermesAgentLease | null;
  /**
   * Whether the lease's process exists: true or false when it could be
   * checked, null when it could not, and the lease's expiry is trusted alone.
   */
  holderAlive: boolean | null;
  /** The newest time anything of the session was written, for an idle session with no newest row. */
  activityAt: number | null;
  now: number;
}

export interface HermesAgentStatus {
  status: SessionStatus;
  /** When the status began, or null when that is not known. */
  since: number | null;
  /** Present only when the status is "needs-you". */
  waitingReason?: WaitingReason;
}

const isWhole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);
const isTimeOrNone = (value: unknown) => value === null || isWhole(value);
const isWordOrNone = (value: unknown) => value === null || typeof value === "string";
const isFlag = (value: unknown) => value === null || value === 0 || value === 1;
const isCountOrNone = (value: unknown) =>
  value === null || (isWhole(value) && (value as number) >= 0);

/** Whether every field the mapping reads has the type Hermes Agent writes, and the role is a known one. */
function readable(input: HermesAgentStatusInput): boolean {
  const { newest, lease } = input;
  if (!isTimeOrNone(input.endedAt) || !isWordOrNone(input.endReason)) return false;
  if (!isTimeOrNone(input.callsAt) || !isFlag(input.approvalLabel)) return false;
  if (!isFlag(input.questionLabel) || !isTimeOrNone(input.labelAt)) return false;
  if (!isCountOrNone(input.openQuestions) || !isCountOrNone(input.openCalls)) return false;
  if (lease !== null && !(isWhole(lease.at) && isWhole(lease.until))) return false;
  if (newest !== null) {
    if (typeof newest.role !== "string" || !HERMES_AGENT_ROLES.includes(newest.role)) return false;
    if (!isWordOrNone(newest.kind) || !isWordOrNone(newest.finish)) return false;
    if (!isFlag(newest.error) || !isTimeOrNone(newest.at)) return false;
  }
  return true;
}

/** Whether the newest row closes a failed turn: Hermes Agent's failure row with an error, or an error finish. */
function failedRow(newest: HermesAgentNewestRow | null): boolean {
  if (newest === null) return false;
  if (newest.role === "assistant" && newest.kind === FAILED_TURN_KIND && newest.error === 1) {
    return true;
  }
  return typeof newest.finish === "string" && FAILED_FINISH_REASONS.includes(newest.finish);
}

/**
 * Maps a Hermes Agent conversation to a status and the time it began,
 * checking each row of this table in order:
 *
 * | Condition                                                         | Status                 | Since                     |
 * | ----------------------------------------------------------------- | ---------------------- | ------------------------- |
 * | A field of the wrong type, or a newest row of an unknown role     | unknown                | none                      |
 * | Live lease, and a `clarify` call of the turn with no result       | needs-you (question)   | the tool call's row       |
 * | Live lease, and the approval label on a call of the turn          | needs-you (permission) | the tool call's row       |
 * | Live lease, and the question label on a call of the turn          | needs-you (question)   | the tool call's row       |
 * | Live lease                                                        | working                | the lease's `acquired_at` |
 * | Newest row is `failed_turn` with an `error`, or an error finish   | failed                 | the newest row            |
 * | `ended_at` is set                                                 | finished               | `ended_at`                |
 * | Anything else                                                     | idle                   | the newest row, else the newest time |
 *
 * A lease is live while its `expires_at` is after `now` and its process was
 * not found gone. Expiry is judged from `now` alone, so a lease that runs out
 * ends "working" on the next poll though no file changed.
 *
 * A wait belongs to the newest tool call, and only while that call is the
 * running turn's: written no earlier than the turn took its lease. A call left
 * with no result by an earlier turn, as when a gateway was killed while it
 * asked, is no wait. A label counts only while it was saved no earlier than
 * that call and one of the call's tools has no result yet. Hermes Agent saves
 * a label at most once a minute, so one can outlast its wait; without these
 * two tests a stale label would put the wait on each new tool call. A wait's
 * time is the call's row, which stays the same while the wait lasts, so one
 * wait is never announced twice.
 *
 * A failed session stays failed once it is ended. It never gives what a
 * session is asking: Hermes Agent keeps that in memory.
 */
export function mapHermesAgentStatus(input: HermesAgentStatusInput): HermesAgentStatus {
  const { newest, lease, now } = input;
  if (!readable(input)) return { status: "unknown", since: null };

  const live = lease !== null && (lease.until as number) > now && input.holderAlive !== false;
  if (live) {
    const callsAt = input.callsAt as number | null;
    const labelAt = input.labelAt as number | null;
    // The newest tool call is the running turn's: written once the turn held its lease.
    const turnCall = callsAt !== null && callsAt >= (lease.at as number);
    // The label was saved for that call, and the call still waits on a tool.
    const labelled =
      turnCall &&
      ((input.openCalls as number | null) ?? 0) > 0 &&
      labelAt !== null &&
      labelAt >= callsAt;
    const since = plausibleTime(callsAt, now);
    if (turnCall && ((input.openQuestions as number | null) ?? 0) > 0) {
      return { status: "needs-you", since, waitingReason: "question" };
    }
    if (labelled && input.approvalLabel === 1) {
      return { status: "needs-you", since, waitingReason: "permission" };
    }
    if (labelled && input.questionLabel === 1) {
      return { status: "needs-you", since, waitingReason: "question" };
    }
    return { status: "working", since: plausibleTime(lease.at, now) };
  }

  if (failedRow(newest)) return { status: "failed", since: plausibleTime(newest?.at, now) };
  if (input.endedAt !== null)
    return { status: "finished", since: plausibleTime(input.endedAt, now) };
  return {
    status: "idle",
    since: plausibleTime(newest?.at, now) ?? plausibleTime(input.activityAt, now),
  };
}
