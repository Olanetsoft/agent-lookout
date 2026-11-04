// How Kimi Code's session files map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// Kimi Code keeps a lock for a session while the session is busy, which names
// the process that holds it, and writes each approval and question it asks, and
// each answer, into the session's event file. It writes how a turn ended into
// the session's `state.json`. This mapping reads only what those say, and was
// worked out from Kimi Code's source at 2.4.1, not checked on a computer
// running it. See docs/adapters/kimi-code.md.

import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";

export interface KimiCodeStatusFields {
  /** Whether a process that runs holds the session's lock. */
  held: boolean;
  /** True when `kimiCodeWaitOf` finds the session waiting for the person. */
  waiting: boolean;
  /** Whether the process Agent Lookout last saw hold the lock runs, with the lock let go. */
  lastHolderRuns: boolean;
  /** Whether `state.json` says the session's last turn failed. */
  lastTurnFailed: boolean;
}

/**
 * Maps what a session's lock and `state.json` say to a session status. The
 * rows are taken in this order:
 *
 * | Lock held | Waits | Last turn failed | Last holder runs | Status    |
 * | --------- | ----- | ---------------- | ---------------- | --------- |
 * | yes       | yes   | any              | any              | needs-you |
 * | yes       | no    | any              | any              | working   |
 * | no        | any   | yes              | any              | failed    |
 * | no        | any   | no               | yes              | idle      |
 * | no        | any   | no               | no               | finished  |
 *
 * Kimi Code lets a session's lock go 3 seconds after the session stops being
 * busy, so no lock does not mean the session is closed. What tells an idle
 * session from a closed one is the process Agent Lookout saw hold the lock:
 * nothing Kimi Code writes says it. A session whose lock Agent Lookout never saw
 * held, as one idle in a Kimi Code opened before it started, is finished until
 * its next turn.
 */
export function mapKimiCodeStatus(fields: KimiCodeStatusFields): SessionStatus {
  if (fields.held) return fields.waiting ? "needs-you" : "working";
  if (fields.lastTurnFailed) return "failed";
  return fields.lastHolderRuns ? "idle" : "finished";
}

/** What is kept of an approval or a question left unanswered: never what it asks. */
export interface KimiCodeInteraction {
  /** Kimi Code's own id for it, which is all that ties its answer to it. */
  id: string;
  kind: "approval" | "question";
  /** When Kimi Code asked, in Unix milliseconds, from the line's `time`. */
  at: number;
}

/** A session's wait, as `kimiCodeWaitOf` finds it. */
export interface KimiCodeWait {
  reason: WaitingReason;
  /** When it began, as a line says, which does not move while it stands. */
  since: number;
  /** The interactions it hangs on. */
  ids: string[];
}

const WAIT_REASONS: Readonly<Record<KimiCodeInteraction["kind"], WaitingReason>> = {
  approval: "permission",
  question: "question",
};

/**
 * What a session waits for from the person, or null when it does not.
 *
 * An unanswered line on disk is not enough to say so, because a process that
 * crashes or closes writes no answer. An interaction counts only when it was
 * asked since the lock now held was taken, so the process that holds the lock
 * can be the one that asked: Kimi Code holds its lock through a turn, and keeps
 * what it waits on in that process's memory. An earlier process's question,
 * left in the file, does not count once another process takes the lock.
 *
 * With two open, an approval is the reason, as Kimi Code's own
 * `resolvePendingInteraction` puts it first, and the time is the oldest's.
 */
export function kimiCodeWaitOf(
  open: Iterable<KimiCodeInteraction>,
  lockTakenAt: number,
): KimiCodeWait | null {
  let reason: WaitingReason | null = null;
  let since = Infinity;
  const ids: string[] = [];
  for (const { id, kind, at } of open) {
    if (at < lockTakenAt) continue;
    if (reason !== "permission") reason = WAIT_REASONS[kind];
    since = Math.min(since, at);
    ids.push(id);
  }
  return reason === null ? null : { reason, since, ids };
}

/**
 * A wait as a poll found it, given the wait the poll before found. It goes on
 * for as long as any interaction it hung on stands, so it keeps the time it
 * began: a later time on a session still waiting would read as a new wait. A
 * wait that shares none with the one before is new, however soon it came.
 */
export function continuedKimiCodeWait(
  before: KimiCodeWait | undefined,
  wait: KimiCodeWait,
): KimiCodeWait {
  if (before === undefined || !wait.ids.some((id) => before.ids.includes(id))) return wait;
  return { ...wait, since: Math.min(before.since, wait.since) };
}
