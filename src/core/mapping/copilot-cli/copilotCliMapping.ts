// How Copilot CLI's sessions map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// A session's status comes from its event log (`copilotCliFold.ts`) and from
// whether a Copilot process holds it: Copilot keeps `inuse.<pid>.lock` in a
// session's folder while a process has the session open, and Agent Lookout
// checks that process (`src/collector/adapters/copilot-cli/locks.ts`).
// Copilot never writes `session.idle`, so idle is read from a last turn that
// asked for no tools, or a task's completion that ends the run, and no timer
// ever turns working into idle. Built from GitHub's docs, the MIT Copilot SDK
// v2.0.1 and open-source readers, never checked on a computer running Copilot
// CLI. See docs/adapters/copilot-cli.md.

import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";
import type { CopilotFold } from "./copilotCliFold.ts";

/**
 * How long a permission request must have been open, when read, to show as
 * waiting for you: 1 second. Copilot writes a request even for one it
 * approves itself, and closes it within a few milliseconds, so a poll that
 * lands between the two would otherwise show a wait that never was. The
 * second is Agent Lookout's choice, not something Copilot documents.
 */
export const PERMISSION_AGE_MS = 1_000;

/** What a session waits on, for telling a wait that goes on from a new one. */
export interface CopilotCliWait {
  since: number | null;
  /** `permission:<requestId>` and `question:<toolCallId>` of what it waits on. */
  ids: string[];
}

export interface CopilotCliFacts {
  fold: CopilotFold;
  /** Whether a lock in the session's folder counts, or null when the folder's locks could not be listed. */
  live: boolean | null;
  /** The log's last write, in epoch milliseconds, as the poll read it. */
  writtenAt: number | null;
  /** The later of the log's last write and the session folder's, which a lock's removal moves. */
  changedAt: number | null;
  now: number;
  /** When this adapter first saw each open permission request, by its `requestId`. */
  seen: ReadonlyMap<string, number>;
  /** The permission requests that waited for you at the last poll: they wait for as long as they are open. */
  waited: ReadonlySet<string>;
}

export interface CopilotCliStatus {
  status: SessionStatus;
  since: number | null;
  waitingReason?: WaitingReason;
  wait?: CopilotCliWait;
  /** Whether the session's last write is shown: only while it works. */
  showsLastWrite: boolean;
}

const UNKNOWN: CopilotCliStatus = { status: "unknown", since: null, showsLastWrite: false };

function earliest(times: readonly (number | null)[]): number | null {
  const known = times.filter((time): time is number => time !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * The open permission requests that wait for you: each open at least
 * `PERMISSION_AGE_MS` by its own time, or by when this adapter first saw it,
 * or that waited at the last poll. Each with when its wait began.
 */
function waitingPermissions(facts: CopilotCliFacts): { ids: string[]; starts: (number | null)[] } {
  const { fold, now, seen, waited } = facts;
  const ids: string[] = [];
  const starts: (number | null)[] = [];
  for (const [request, at] of fold.permissions) {
    const written = plausibleTime(at, now);
    const first = seen.get(request);
    const old =
      waited.has(request) ||
      (written !== null && now - written >= PERMISSION_AGE_MS) ||
      (first !== undefined && now - first >= PERMISSION_AGE_MS);
    if (!old) continue;
    ids.push(`permission:${request}`);
    starts.push(written ?? (first === undefined ? null : plausibleTime(first, now)));
  }
  return { ids, starts };
}

/**
 * A session's status, the first row that holds:
 *
 * | Row | When                                                                                   | Status    | Since                         |
 * | --- | -------------------------------------------------------------------------------------- | --------- | ----------------------------- |
 * | 1   | the newest main lifecycle line is `session.shutdown` of type `error`                   | failed    | that line's time              |
 * | 2   | the newest main lifecycle line is any other `session.shutdown`                         | finished  | that line's time              |
 * | 3   | no lock counts                                                                         | finished  | the log's or folder's last change |
 * | 4   | its locks could not be listed, or a line that would decide could not be read           | unknown   | none                          |
 * | 5   | a permission request has been open at least 1 second                                  | needs-you | the oldest such request's or open `ask_user` call's time |
 * | 6   | an `ask_user` call is open                                                             | needs-you | the oldest such call's start  |
 * | 7   | the newest main lifecycle line is `session.error`                                      | unknown   | none                          |
 * | 8   | a main turn is open, the newest main lifecycle line is `user.message`, a `turn_end` of a turn that asked for tools or a `session.task_complete` whose `outcome` is `continue`, or a sub-agent's turn or another tool call is open | working | the newest request's time |
 * | 9   | lines went unread and no main turn line came since, or the last turn's tool requests could not be read, or a `session.task_complete` did not say whether the run goes on, or no lifecycle line was read | unknown | none |
 * | 10  | anything else: the last turn asked for no tools, an `abort`, a `session.task_complete` whose `outcome` is `completed`, or only a start or resume so far | idle | that line's time |
 *
 * A turn that holds a `session.task_complete` whose `outcome` is `completed`
 * asked for nothing more, and one whose `outcome` does not say is not known
 * to (`copilotCliFold.ts`).
 *
 * Rows 5 and 6 are one wait, on every request and call open in it, so it goes
 * on while any of them stays open. Its reason is a permission while one waits.
 *
 * Every time is judged against `now` on every poll, and one that cannot be
 * right is none.
 */
export function copilotCliStatusOf(facts: CopilotCliFacts): CopilotCliStatus {
  const { fold, live, now } = facts;
  const believed = (at: number | null) => plausibleTime(at, now);
  const { newest } = fold;
  if (newest?.sort === "shutdown") {
    return {
      status: newest.shutdown === "error" ? "failed" : "finished",
      since: believed(newest.at),
      showsLastWrite: false,
    };
  }
  if (live === false) {
    const changed = facts.changedAt === null ? null : believed(Math.floor(facts.changedAt));
    return { status: "finished", since: changed, showsLastWrite: false };
  }
  if (live === null || fold.unsure) return UNKNOWN;

  const permissions = waitingPermissions(facts);
  const ids = [...permissions.ids, ...[...fold.questions.keys()].map((call) => `question:${call}`)];
  if (ids.length > 0) {
    const since = earliest([...permissions.starts, ...[...fold.questions.values()].map(believed)]);
    return {
      status: "needs-you",
      since,
      waitingReason: permissions.ids.length > 0 ? "permission" : "question",
      wait: { since, ids },
      showsLastWrite: false,
    };
  }
  if (newest?.sort === "error") return UNKNOWN;

  const working =
    fold.turn.state === "open" ||
    newest?.sort === "user" ||
    (newest?.sort === "turn-end" && newest.tools === true) ||
    (newest?.sort === "task-complete" && newest.goesOn === true) ||
    fold.subTurns.size > 0 ||
    fold.tools.size > 0;
  if (working) {
    const turnAt = fold.turn.state === "open" ? fold.turn.at : null;
    return {
      status: "working",
      since: believed(fold.askedAt) ?? believed(turnAt) ?? believed(newest?.at ?? null),
      showsLastWrite: true,
    };
  }
  if (
    newest === null ||
    fold.turn.state === "unknown" ||
    (newest.sort === "turn-end" && newest.tools === null) ||
    (newest.sort === "task-complete" && newest.goesOn === null)
  ) {
    return UNKNOWN;
  }
  return { status: "idle", since: believed(newest.at), showsLastWrite: false };
}
