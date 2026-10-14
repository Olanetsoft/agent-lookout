import { mapQwenCodeStatus } from "../../../core/mapping/qwen-code/qwenCodeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId, Surface } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { ChatState } from "./chatRecords.ts";
import { TERMINAL_KIND, type RegistryEntry } from "./registry.ts";

export const SOURCE_ID: SourceId = "qwen-code";

/**
 * A session's record and its first line are written a moment apart. A time
 * this little before the start is the same moment, not a contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

/** A session's id in the session model. */
export function qwenCodeId(sessionId: string): string {
  return `${SOURCE_ID}:${sessionId}`;
}

/** Where a session runs, from its record's kind: only Qwen Code in a terminal is known. */
function surfaceOf(kind: string): Surface {
  return kind === TERMINAL_KIND ? "terminal" : "unknown";
}

/** The file's modified time, when it could be right and is not before the session began. */
function writtenAtOf(
  writtenAt: number | undefined,
  startedAt: number | null,
  now: number,
): number | null {
  const at = writtenAt === undefined ? null : plausibleTime(Math.floor(writtenAt), now);
  if (at === null || (startedAt !== null && at < startedAt - WRITE_ORDER_SLACK_MS)) return null;
  return at;
}

/** What the parts of a session that do not hang on its status have in common. */
function base(entry: RegistryEntry, title: string | null, startedAt: number | null) {
  const id = qwenCodeId(entry.sessionId);
  const project = projectOf(entry.cwd);
  return {
    id,
    source: SOURCE_ID,
    surface: surfaceOf(entry.kind),
    // A title made only of spaces is no title. It is cleaned and cut as every other agent's is.
    name: sessionName(title ?? "") || project || id,
    cwd: entry.cwd,
    project,
    startedAt,
    pid: entry.pid,
    links: {},
  };
}

export interface QwenCodeSessionInput {
  entry: RegistryEntry;
  /** What its chat file says, or null when it has none. */
  chat: ChatState | null;
  /** The chat file's modified time, as the `lstat` made before reading it gave it. */
  writtenAt?: number;
  /**
   * When `/clear` or `/resume` moved its process to this session, as Agent
   * Lookout saw it: the last poll that found the process with its earlier one.
   * Without it, the session is its process's since the process registered it.
   */
  tookOverAt?: number;
  now: number;
}

/**
 * One Qwen Code session whose process is running, in the shared model.
 *
 * - The status comes from the end of its chat file and when its process
 *   registered it, or moved to it with /clear or /resume (`mapQwenCodeStatus`).
 *   It is never "needs-you" or "failed".
 * - Its name is the title Qwen Code gave it, or the one set with /rename,
 *   then its folder's name, then its id. What was typed is never used.
 * - Its folder is the one its record names now, which /cd moves on.
 * - It began with its chat file's first line, when the file was read from its
 *   start, and otherwise when its process registered it or moved to it.
 * - Its last write is its chat file's modified time: every line Qwen Code
 *   adds moves it on. Without a chat file it has none.
 * - It has its process's id, and no link, Jump or Stop.
 */
export function qwenCodeSession(input: QwenCodeSessionInput): Session {
  const { entry, chat, now } = input;
  const liveSince = plausibleTime(input.tookOverAt ?? entry.startedAt, now);
  const { status, since } = mapQwenCodeStatus(chat?.fold ?? null, liveSince);
  const startedAt = plausibleTime(chat?.firstAt ?? null, now) ?? liveSince;
  let statusSince = plausibleTime(since, now);
  if (
    statusSince !== null &&
    startedAt !== null &&
    statusSince < startedAt - WRITE_ORDER_SLACK_MS
  ) {
    // A status cannot have begun before the session did. An idle session has
    // been idle since it began at least: its process registered it before the
    // first line of its chat file.
    statusSince = status === "idle" ? startedAt : null;
  }
  const session: Session = {
    ...base(entry, chat?.fold.title ?? null, startedAt),
    status,
    statusSince,
    alive: true,
    stale: isStale({ status, statusSince }, now),
  };
  const writtenAt = writtenAtOf(input.writtenAt, startedAt, now);
  if (writtenAt !== null) session.lastWriteAt = writtenAt;
  return session;
}

/**
 * A session that was listed open and whose process has gone, or let it go, since `closedAt`.
 * When its process runs on, as after /clear or /resume, it names no process: that one has not ended.
 */
export function closedQwenCodeSession(
  session: Session,
  closedAt: number,
  processRunsOn = false,
): Session {
  const closed: Session = { ...session, status: "finished", statusSince: closedAt, stale: false };
  if (!processRunsOn) return { ...closed, alive: false };
  const { pid: _pid, alive: _alive, ...rest } = closed;
  return rest;
}

/**
 * A session whose record Qwen Code left behind when its process ended
 * without letting it go, as a crash does, found when Agent Lookout starts.
 * It is over since its chat file was last written, otherwise since its
 * process registered it. Its chat file is not read: it takes its folder's
 * name.
 */
export function leftBehindQwenCodeSession(
  entry: RegistryEntry,
  writtenAt: number | undefined,
  now: number,
): Session {
  const startedAt = plausibleTime(entry.startedAt, now);
  const lastWriteAt = writtenAtOf(writtenAt, startedAt, now);
  const session: Session = {
    ...base(entry, null, startedAt),
    status: "finished",
    statusSince: lastWriteAt ?? startedAt,
    alive: false,
    stale: false,
  };
  if (lastWriteAt !== null) session.lastWriteAt = lastWriteAt;
  return session;
}
