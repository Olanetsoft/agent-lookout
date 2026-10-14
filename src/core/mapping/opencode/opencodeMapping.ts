// How OpenCode 1.x's sessions map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// OpenCode keeps every session in one SQLite database, `opencode.db`. Each
// step of a reply is an assistant message of its own, written when the step
// starts and again when it ends. Whether a session is busy, and every wait for
// an approval or an answer, OpenCode keeps in memory only, so a session is
// working, idle, failed, finished or unknown here, and never "needs-you". This
// was built from OpenCode's source at v1.19.0 and has not yet been checked on a
// computer running OpenCode. See docs/adapters/opencode.md for where each value
// comes from.

import type { SessionStatus } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";

/**
 * How long after a step ends that asked for tools, or gave no reason it
 * ended, the session is still taken to be working. OpenCode writes the next
 * step's message in the same pass, a moment later. A turn that ends there, as
 * one does when an approval is turned down, is idle once this has passed.
 */
export const STEP_GAP_MS = 10_000;

/** The error OpenCode records on a reply that was stopped: Esc, or OpenCode quitting mid-reply. */
export const ABORTED_ERROR = "MessageAbortedError";

/** The other errors OpenCode 1.19.0 records on a reply, each of which ends it as failed. */
export const FAILED_ERRORS: readonly string[] = [
  "ProviderAuthError",
  "UnknownError",
  "MessageOutputLengthError",
  "StructuredOutputError",
  "ContextOverflowError",
  "ContentFilterError",
  "APIError",
];

/** The reasons a step ended that OpenCode takes to mean the reply goes on. */
const NOT_FINISHED = new Set(["tool-calls", "unknown"]);

/**
 * What OpenCode's database says of a session's newest message, by
 * `(time_created, id)`. Each field is as it was read, so one of the wrong type
 * makes the status unknown rather than a guess. Null when there is no message.
 */
export interface OpencodeMessageFields {
  /** `$.role`: `user` or `assistant`. */
  role: unknown;
  /** `$.time.completed`, in epoch milliseconds: set once an assistant step ends. Null while it runs. */
  completedAt: unknown;
  /** `$.error.name`, or null when the message records no error. */
  error: unknown;
  /** `$.finish`, the reason the step ended, or null when none was given. */
  finish: unknown;
  /** How many of its tool parts OpenCode would wait on before it ends the turn. */
  tools: unknown;
}

export interface OpencodeStatusFields {
  /** The newest message, or null when the session has none. */
  message: OpencodeMessageFields | null;
  /**
   * Whether an OpenCode program has the database open: its `opencode.db-wal`
   * file holds something. While none does, every session is finished, unless
   * it ended on an error or cannot be read.
   */
  open: boolean;
  now: number;
}

const isTime = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);

/** What the newest message says while the database is open, or `unknown`. */
function openStatus(message: OpencodeMessageFields | null, now: number): SessionStatus {
  if (message === null) return "idle";
  const { role, completedAt, error, finish, tools } = message;
  if (role === "user") return "working";
  if (role !== "assistant") return "unknown";
  if (completedAt !== null && !isTime(completedAt)) return "unknown";
  if (error !== null && typeof error !== "string") return "unknown";
  if (finish !== null && typeof finish !== "string") return "unknown";
  if (tools !== null && !(isTime(tools) && (tools as number) >= 0)) return "unknown";
  if (error === ABORTED_ERROR) return "idle";
  if (typeof error === "string") return FAILED_ERRORS.includes(error) ? "failed" : "unknown";
  if (completedAt === null) return "working";
  const goesOn = finish === null || NOT_FINISHED.has(finish as string) || (tools as number) > 0;
  if (!goesOn) return "idle";
  // A clock set back counts as time enough.
  const since = now - (completedAt as number);
  return since >= 0 && since < STEP_GAP_MS ? "working" : "idle";
}

/**
 * Maps a root session's newest message, and whether OpenCode has the
 * database open, to a status.
 *
 * | Newest message                                                      | Open    | Closed   |
 * | ------------------------------------------------------------------- | ------- | -------- |
 * | none                                                                | idle    | finished |
 * | `user`                                                              | working | finished |
 * | `assistant`, no `time.completed`                                    | working | finished |
 * | `assistant`, error `MessageAbortedError`                            | idle    | finished |
 * | `assistant`, error that is one of the other seven names             | failed  | failed   |
 * | `assistant`, error with any other name                              | unknown | unknown  |
 * | `assistant`, ended, `finish` is `tool-calls`, `unknown` or missing, or a tool to wait on: under `STEP_GAP_MS` ago | working | finished |
 * | the same, `STEP_GAP_MS` or more ago                                 | idle    | finished |
 * | `assistant`, ended, any other `finish`                              | idle    | finished |
 * | any other role, or a field of the wrong type                        | unknown | unknown  |
 *
 * An error OpenCode records ends the step, so it is read first. A session
 * that failed, or cannot be read, stays so once the database is closed. It
 * never returns "needs-you": OpenCode keeps its approval waits and its
 * questions in memory, so a session waiting for the person shows as working.
 */
export function mapOpencodeStatus(fields: OpencodeStatusFields): SessionStatus {
  const open = openStatus(fields.message, fields.now);
  if (open === "failed" || open === "unknown") return open;
  return fields.open ? open : "finished";
}

export interface OpencodeTimes {
  /** `session.time_created`. */
  sessionCreatedAt: unknown;
  /** `time_created` of the newest message. */
  messageCreatedAt: unknown;
  /** `time_created` of the newest message from the person. */
  userCreatedAt: unknown;
  /** `$.time.completed` of the newest message. */
  completedAt: unknown;
  /** The newest time OpenCode wrote anything of the session: its row, its newest message or that message's parts. */
  activityAt: number | null;
}

/**
 * When the session's status began, as far as its rows say. A time that could
 * not be right is not known.
 *
 * - working: when the person last wrote, which starts the turn; else the
 *   newest message's start; else the session's.
 * - idle, failed and finished: when the newest step ended; else the newest
 *   time anything of the session was written.
 * - unknown: not known.
 */
export function opencodeStatusSince(
  status: SessionStatus,
  times: OpencodeTimes,
  now: number,
): number | null {
  if (status === "unknown" || status === "needs-you") return null;
  if (status === "working") {
    return (
      plausibleTime(times.userCreatedAt, now) ??
      plausibleTime(times.messageCreatedAt, now) ??
      plausibleTime(times.sessionCreatedAt, now)
    );
  }
  return plausibleTime(times.completedAt, now) ?? plausibleTime(times.activityAt, now);
}
