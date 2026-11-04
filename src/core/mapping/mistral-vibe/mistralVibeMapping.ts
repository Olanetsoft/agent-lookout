// How Mistral Vibe's session files map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// Vibe keeps each session as a store of its own under `unified/<session id>/`,
// with the public state of the session (its status, title and times) in the
// generation `CURRENT` names and, newer than that, in the session's journal.
// Whether a Vibe program has the session open is its lease in `active/`, and
// what it waits for from the person are the callbacks it journals. This
// mapping reads only what those say, and was worked out from the source of
// Vibe 2.26.1 and 3.0.4, not checked on a machine running it. See
// docs/adapters/mistral-vibe.md.

import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";

/**
 * Whether a Vibe program holds the session's lease: true or false when its
 * folder of leases says, "unknown" when that folder cannot be listed (see
 * `vibeLeaseHeld`).
 */
export type VibeHeld = boolean | "unknown";

/** The pattern every Vibe session id follows, which Vibe checks before it names a file by one. */
export const VIBE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** What every id Vibe gives a subagent's session begins with. */
export const SUBAGENT_ID_PREFIX = "child-";

export interface MistralVibeStatusFields {
  /**
   * `session.status.type` of the newest public state read: `idle`, `running`,
   * `blocked`, `failed` or `archived`, at Vibe 2.26.1 and 3.0.4. Anything that is
   * not a string, such as `undefined` for a state that could not be read, is not
   * known.
   */
  statusType: unknown;
  held: VibeHeld;
  /** True when the store was written by a newer Vibe than Agent Lookout knows. */
  tooNew?: boolean;
  /** True when `vibeWaitOf` finds the session waiting for the person. */
  waiting?: boolean;
}

/** The public statuses of a session that is open and can carry on. */
const OPEN_STATUSES = new Set(["idle", "running", "blocked"]);

/**
 * The public statuses of a session with a turn in flight, the only ones an
 * open callback holds it in (`_held_by_open_callback` in
 * harness/.../vibe/_session.py).
 */
const IN_TURN_STATUSES = new Set(["running", "blocked"]);

/** Whether a session's public status says a turn is in flight. */
export function isVibeTurnInFlight(statusType: unknown): boolean {
  return typeof statusType === "string" && IN_TURN_STATUSES.has(statusType);
}

/**
 * Maps what a Vibe session's newest public state and its lease say to a
 * session status. The rows are taken in this order:
 *
 * | Status type                                     | Held               | Status   |
 * | ----------------------------------------------- | ------------------ | -------- |
 * | not read, or a store newer than Agent Lookout knows | any            | unknown  |
 * | `failed`                                        | any                | failed   |
 * | `idle`, `running` or `blocked`                  | false              | finished |
 * | `running` or `blocked`, waiting                 | true               | needs-you |
 * | `running` or `blocked`                          | true, or not known | working  |
 * | `idle`                                          | true, or not known | idle     |
 * | `archived`, or anything else                    | any                | unknown  |
 *
 * Vibe never writes `blocked` to its files, only to the state it holds in
 * memory, so a session that waits reads as `running` there, and only the
 * callbacks it journals tell it from one that works (`vibeWaitOf`). A session
 * that closes while it waits is finished, with no reason. A failed turn stays
 * failed once no program holds the session. `archived` is a word Vibe uses
 * only between its own programs, never on disk, so it is not known here.
 */
export function mapMistralVibeStatus(fields: MistralVibeStatusFields): SessionStatus {
  const { statusType, held } = fields;
  if (fields.tooNew === true || typeof statusType !== "string") return "unknown";
  if (statusType === "failed") return "failed";
  if (!OPEN_STATUSES.has(statusType)) return "unknown";
  if (held === false) return "finished";
  if (statusType === "idle") return "idle";
  return fields.waiting === true && held === true ? "needs-you" : "working";
}

/** What is kept of a callback Vibe has open: never a tool's arguments, a question or an answer. */
export interface VibeCallback {
  /** Vibe's own id for it, which is all that ties its result to it. */
  id: string;
  /** `approval` or `user_input`, or another word a newer Vibe writes. */
  kind: string;
  /** When Vibe asked, in Unix milliseconds, from the record's `routing.createdAt`. */
  createdAt: number;
}

/** A session's wait, as `vibeWaitOf` finds it. */
export interface VibeWait {
  reason: WaitingReason;
  /** When it began, as a record says, which does not move while it stands. */
  since: number;
  /** The callbacks it hangs on. */
  ids: string[];
}

/** The kinds of callback that wait for the person, each with the reason it is shown with. */
const WAIT_REASONS: ReadonlyMap<string, WaitingReason> = new Map([
  ["approval", "permission"],
  ["user_input", "question"],
]);

export interface VibeWaitFields {
  /** The callbacks the store says are open, in the order Vibe opened them. */
  callbacks: Iterable<VibeCallback>;
  /** `session.status.type` of the newest public state read. */
  statusType: unknown;
  held: VibeHeld;
  /** When the process that holds the lease took it, or null when the lease does not say. */
  leaseTakenAt: number | null;
  /** When the newest turn began, or null when the state does not say. */
  turnStartedAt: number | null;
}

/**
 * What a session waits for from the person, or null when it does not. An open
 * callback on disk is not enough to say so, because Vibe does not always close
 * one. A callback counts only:
 *
 * - while a program holds the session, shown by a lease that names when it was
 *   taken. Vibe keeps what it waits on in its process's memory, and a killed
 *   Vibe writes nothing. With no way to tell, as while the folder of leases
 *   cannot be listed, no wait is claimed;
 * - while a turn is in flight, as Vibe itself decides (`isVibeTurnInFlight`);
 * - when it was opened after the lease was taken. The program that holds the
 *   lease cannot be waiting on what an earlier one opened. Vibe closes an
 *   earlier program's approvals as it reopens a session, but not its questions
 *   (`_close_restarted_approval_callbacks`);
 * - when it was opened after the newest turn began. A callback whose action
 *   Vibe abandoned stays open on disk, and a later turn does not wait on it.
 *
 * Of a kind this mapping does not know, a callback does not count: Vibe holds
 * back only an approval and a question as blocking.
 *
 * With two open at once, the reason is the newest's, and of two opened in one
 * millisecond the later one's, as Vibe's own `_blocked_status` takes it, and the
 * time is the oldest's, so that a second ask does not move the time of a wait
 * that stands (`continuedVibeWait` holds it there once the oldest is settled).
 */
export function vibeWaitOf(fields: VibeWaitFields): VibeWait | null {
  const { held, leaseTakenAt, turnStartedAt } = fields;
  if (held !== true || leaseTakenAt === null || !isVibeTurnInFlight(fields.statusType)) return null;
  const from = Math.max(leaseTakenAt, turnStartedAt ?? leaseTakenAt);
  let newest: VibeCallback | null = null;
  let since = Infinity;
  const ids: string[] = [];
  for (const callback of fields.callbacks) {
    if (!WAIT_REASONS.has(callback.kind) || callback.createdAt < from) continue;
    if (newest === null || callback.createdAt >= newest.createdAt) newest = callback;
    since = Math.min(since, callback.createdAt);
    ids.push(callback.id);
  }
  const reason = newest === null ? undefined : WAIT_REASONS.get(newest.kind);
  return reason === undefined ? null : { reason, since, ids };
}

/**
 * A wait as a poll found it, given the wait the poll before found. It goes on
 * for as long as any callback it hung on stands, so it keeps the time it
 * began: with two open, settling the older one leaves the person waited on,
 * and a later time on a session still waiting would read as a new wait. A wait
 * that shares no callback with the one before is new, however soon it came.
 */
export function continuedVibeWait(before: VibeWait | undefined, wait: VibeWait): VibeWait {
  if (before === undefined || !wait.ids.some((id) => before.ids.includes(id))) return wait;
  return { ...wait, since: Math.min(before.since, wait.since) };
}

/**
 * Whether a Vibe program holds a session, from its folder of leases.
 *
 * - With no folder that can be listed, it is not known.
 * - With no `<id>.lock`, no program holds it.
 * - With one, a program holds it while the process its `<id>.lock.json` names
 *   runs. A lock with no readable pid beside it is held: Vibe writes the lock
 *   first and the pid next, so it is a program taking the lease. A pid that is
 *   no longer running is a lease a program that crashed left behind.
 */
export function vibeLeaseHeld(fields: {
  /** Whether the folder of leases could be listed. */
  leaseFolder: boolean;
  /** Whether `<id>.lock` is in it. */
  locked: boolean;
  /** Whether the pid the lease names runs, or null when it names none that could be read. */
  alive: boolean | null;
}): VibeHeld {
  if (!fields.leaseFolder) return "unknown";
  if (!fields.locked) return false;
  return fields.alive !== false;
}

/**
 * Whether a Vibe session is one a person would look for: a session they
 * started, or a fork of one, and not a subagent another session started.
 * A subagent's id begins with `child-`, and its store calls its identity
 * `subagent`. A session whose identity is missing or unfamiliar is kept,
 * because nothing says it is a helper.
 */
export function isMistralVibeUserSession(sessionId: string, kind?: unknown): boolean {
  if (sessionId.startsWith(SUBAGENT_ID_PREFIX)) return false;
  return kind !== "subagent";
}
