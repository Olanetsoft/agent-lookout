import {
  mapCodexStatus,
  mapCodexSurface,
  type CodexLiveness,
} from "../../../core/mapping/codexMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import { parseCodexTime, type RolloutState } from "./rolloutFile.ts";

export const SOURCE_ID: SourceId = "codex";

/**
 * A session's first line and its later lines are written a moment apart. A
 * status time this little before the start is the same moment, not a
 * contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

/** When the session was last written to, as far as its lines say, or null. */
export function lastActivity(state: RolloutState, now: number): number | null {
  return (
    plausibleTime(state.lastLineAt, now) ??
    plausibleTime(state.lastTurnAt, now) ??
    plausibleTime(parseCodexTime(state.meta?.timestamp), now)
  );
}

export interface CodexSessionInput {
  /** In lowercase, from the file's name. */
  threadId: string;
  state: RolloutState;
  /** The name from `session_index.jsonl`, when the session has one. */
  name?: string;
  live: CodexLiveness;
  /** The file's modified time, as the `lstat` made before reading it gave it. */
  writtenAt?: number;
  now: number;
}

/**
 * One Codex session in the shared model.
 *
 * - The status comes from the last turn line and whether Codex has the session
 *   open (`mapCodexStatus`, `codexLiveness`). It is never "needs-you".
 * - The app comes from the program that created the session and its `source`
 *   (`mapCodexSurface`).
 * - The status time is the last turn line's time while the session is open.
 *   A session that has ended, or has not begun a turn, has been so since its
 *   last line. An unknown status has no time.
 * - The last write is the file's modified time: every line Codex adds moves
 *   it on. A time that could not be right, or that is before the session
 *   began, is not known.
 * - There is no pid, no `alive` and no link: Codex's files name no process, and
 *   its deep link into the desktop app is undocumented.
 */
export function codexSession(input: CodexSessionInput): Session {
  const { threadId, state, live, now } = input;
  const id = `${SOURCE_ID}:${threadId}`;
  const cwd = state.meta?.cwd ?? null;
  const project = projectOf(cwd);
  const status = mapCodexStatus({ lastTurn: state.lastTurn, live });

  const startedAt = plausibleTime(parseCodexTime(state.meta?.timestamp), now);
  let statusSince: number | null = null;
  if (status === "working" || (status === "idle" && state.lastTurn !== null)) {
    statusSince = plausibleTime(state.lastTurnAt, now);
  } else if (status === "idle" || status === "finished") {
    statusSince = plausibleTime(state.lastLineAt, now);
  }
  if (
    statusSince !== null &&
    startedAt !== null &&
    statusSince < startedAt - WRITE_ORDER_SLACK_MS
  ) {
    // A status cannot have begun before the session did.
    statusSince = null;
  }

  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: mapCodexSurface(state.meta?.source, state.meta?.originator),
    // A name made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(input.name ?? "") || project || id,
    cwd,
    project,
    status,
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  // The system gives the time with a fraction of a millisecond. A file cannot
  // have been written to before its session began.
  const writtenAt =
    input.writtenAt === undefined ? null : plausibleTime(Math.floor(input.writtenAt), now);
  const beforeStart =
    writtenAt !== null && startedAt !== null && writtenAt < startedAt - WRITE_ORDER_SLACK_MS;
  if (writtenAt !== null && !beforeStart) session.lastWriteAt = writtenAt;
  return session;
}
