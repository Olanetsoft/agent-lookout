// How Mistral Vibe's session files map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// Vibe keeps each session as a store of its own under `unified/<session id>/`,
// with the public state of the session (its status, title and times) in the
// generation `CURRENT` names and, newer than that, in the session's journal.
// Whether a Vibe program has the session open is its lease in `active/`. This
// mapping reads only what those say, and was worked out from Vibe 2.26.1's
// source, not checked on a machine running it. See docs/adapters/mistral-vibe.md.

import type { SessionStatus } from "../../sessions/session.ts";

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
   * `blocked`, `failed` or `archived` at Vibe 2.26.1. Anything that is not a
   * string, such as `undefined` for a state that could not be read, is not known.
   */
  statusType: unknown;
  held: VibeHeld;
  /** True when the store was written by a newer Vibe than Agent Lookout knows. */
  tooNew?: boolean;
}

/** The public statuses of a session that is open and can carry on. */
const OPEN_STATUSES = new Set(["idle", "running", "blocked"]);

/**
 * Maps what a Vibe session's newest public state and its lease say to a
 * session status. The rows are taken in this order:
 *
 * | Status type                                     | Held               | Status   |
 * | ----------------------------------------------- | ------------------ | -------- |
 * | not read, or a store newer than Agent Lookout knows | any            | unknown  |
 * | `failed`                                        | any                | failed   |
 * | `idle`, `running` or `blocked`                  | false              | finished |
 * | `running`                                       | true, or not known | working  |
 * | `blocked`                                       | true, or not known | working  |
 * | `idle`                                          | true, or not known | idle     |
 * | `archived`, or anything else                    | any                | unknown  |
 *
 * It never returns "needs-you" yet: this version does not read the requests
 * Vibe journals while it waits for an approval or an answer. Vibe never writes
 * `blocked` to its files, only to the state it holds in memory, so a session
 * that waits reads as `running`, and shows as working. A failed turn stays
 * failed once no program holds the session. `archived` is a word Vibe uses
 * only between its own programs, never on disk, so it is not known here.
 */
export function mapMistralVibeStatus(fields: MistralVibeStatusFields): SessionStatus {
  const { statusType, held } = fields;
  if (fields.tooNew === true || typeof statusType !== "string") return "unknown";
  if (statusType === "failed") return "failed";
  if (!OPEN_STATUSES.has(statusType)) return "unknown";
  if (held === false) return "finished";
  return statusType === "idle" ? "idle" : "working";
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
