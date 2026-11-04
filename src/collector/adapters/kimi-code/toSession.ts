import {
  mapKimiCodeStatus,
  type KimiCodeWait,
} from "../../../core/mapping/kimi-code/kimiCodeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { SessionLock } from "./locks.ts";
import type { IndexedSession } from "./sessionIndex.ts";
import type { SessionState } from "./sessionState.ts";

export const SOURCE_ID: SourceId = "kimi-code";

/**
 * A session's first state and its later writes are made a moment apart. A time
 * this little before the start is the same moment, not a contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

export interface KimiCodeSessionInput {
  session: IndexedSession;
  state: SessionState;
  /** The session's lock, when a process that runs holds it. */
  lock: SessionLock | null;
  /** The process Agent Lookout last saw hold it, when that runs with the lock let go. */
  lastHolder: SessionLock | null;
  /** What it waits for from the person, when it does (`kimiCodeWaitOf`). */
  wait: KimiCodeWait | null;
  /** `state.json`'s modified time. */
  stateWrittenAt: number;
  /** The event file's modified time, when a lock is held and it was looked up. */
  wireWrittenAt?: number;
  now: number;
}

/**
 * One Kimi Code session in the shared model.
 *
 * - The status comes from its lock, whether it waits, how its last turn ended
 *   and whether its last holder runs (`mapKimiCodeStatus`). It is "needs-you",
 *   with the reason "permission" for an approval and "question" for a question,
 *   and never has a `waitingText`: what Kimi Code asks is never kept.
 * - It is named by the title a model or a person set, else its folder's name,
 *   else its id. Its default title, the start of its first prompt, is never kept
 *   (`sessionState.ts`).
 * - The status time is when the lock was taken while it works, when the wait
 *   began while it needs you, and otherwise `updatedAt`, which Kimi Code moves
 *   at each prompt and each turn's end, else `state.json`'s modified time.
 * - The last write is the event file's modified time, looked up only while a
 *   lock is held.
 * - It has the process's id while one runs that holds it or last held it. There
 *   is no link, no Jump and no Stop. The app is not known: the adapter keeps
 *   nothing that says which of Kimi Code's programs a session runs in.
 */
export function kimiCodeSession(input: KimiCodeSessionInput): Session {
  const { session, state, lock, lastHolder, wait, now } = input;
  const status = mapKimiCodeStatus({
    held: lock !== null,
    waiting: wait !== null,
    lastHolderRuns: lastHolder !== null,
    lastTurnFailed: state.lastTurnFailed,
  });
  const id = `${SOURCE_ID}:${session.id}`;
  const cwd = state.folder ?? session.folder;
  const project = projectOf(cwd);
  const startedAt = plausibleTime(state.createdAt, now);

  const notBeforeStart = (at: number | null) =>
    at !== null && startedAt !== null && at < startedAt - WRITE_ORDER_SLACK_MS ? null : at;

  let statusSince: number | null;
  if (status === "needs-you") {
    statusSince = notBeforeStart(plausibleTime(wait?.since ?? null, now));
  } else if (status === "working") {
    statusSince = notBeforeStart(plausibleTime(lock?.startedAt ?? null, now));
  } else {
    statusSince =
      notBeforeStart(plausibleTime(state.updatedAt, now)) ??
      notBeforeStart(plausibleTime(Math.floor(input.stateWrittenAt), now));
  }

  const result: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // A name made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(state.ownName ?? "") || project || id,
    cwd,
    project,
    status,
    ...(status === "needs-you" && wait ? { waitingReason: wait.reason } : {}),
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  const process = lock ?? lastHolder;
  if (process !== null) {
    result.pid = process.pid;
    result.alive = true;
  }
  if (input.wireWrittenAt !== undefined) {
    const lastWriteAt = notBeforeStart(plausibleTime(Math.floor(input.wireWrittenAt), now));
    if (lastWriteAt !== null) result.lastWriteAt = lastWriteAt;
  }
  return result;
}
