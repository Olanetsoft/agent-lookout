import { createHash } from "node:crypto";

import { KEEP_AWAKE_WORKING_MS } from "../../../core/keep-awake/keepAwakeRule.ts";
import type { GeminiCliStatus } from "../../../core/mapping/gemini-cli/geminiCliMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { ChatFileState } from "./chatFile.ts";

export const SOURCE_ID: SourceId = "gemini-cli";

/** What ends the id of a session read from the folder Gemini CLI keeps under macOS Seatbelt. */
export const SEATBELT_ID_END = ".seatbelt";

/**
 * A session's id in Agent Lookout: Gemini CLI's own id, then a dot and a short
 * hash of the project's folder in `tmp/`, since two projects can each hold a
 * session of one id. The hash keeps the id the same from poll to poll without
 * writing the project's name into the history. Gemini CLI's ids hold no dot,
 * and nor does the hash.
 *
 * A session in the folder Gemini CLI keeps under macOS Seatbelt,
 * `~/.cache/.gemini`, has `.seatbelt` after that, since each folder has its
 * own projects, and the same project folder name can be in both. So the id of
 * a session in `~/.gemini` has one dot after `gemini-cli:` and that of one in
 * `~/.cache/.gemini` has two: the two are never the same.
 */
export function geminiCliSessionId(slug: string, sessionId: string, seatbelt = false): string {
  const project = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  return `${SOURCE_ID}:${sessionId}.${project}${seatbelt ? SEATBELT_ID_END : ""}`;
}

/**
 * How long a batch of tool calls that ended is taken to be working while it is
 * the newest message. Gemini CLI writes the batch, then does other work, which
 * can ask the network, before it writes the tools' results. A batch still the
 * newest after this long, as a tool that stops the agent leaves it, is unknown.
 */
export const BATCH_GRACE_MS = 30_000;

/**
 * How long a reply with a tool call that has not ended is taken to be working
 * while the session writes nothing: 30 minutes, the time keep-awake counts a
 * quiet working session for, and DeepSeek Harness, fx and Unreal Agent believe
 * a turn nothing ended. Gemini CLI 0.69.0 writes nothing while a tool waits for
 * approval or runs, and its files name no process, so a session closed or
 * killed then leaves the same line, and is unknown after this.
 */
export const QUIET_MS = KEEP_AWAKE_WORKING_MS;

/**
 * The status the lines replay to, judged against the clock: a reply whose tool
 * waits or runs is working while the session wrote in the last `QUIET_MS`, and
 * a batch of tool calls that ended a moment ago is working too.
 */
function statusAt(status: GeminiCliStatus, now: number, wroteAt: number | null): GeminiCliStatus {
  if (status.status !== "unknown") return status;
  if (status.pending !== undefined) {
    if (wroteAt === null || now - wroteAt >= QUIET_MS) return status;
    return { status: "working", since: status.pending.workingSince };
  }
  if (status.batch === undefined) return status;
  const endedAt = plausibleTime(status.batch.endedAt, now);
  if (endedAt === null || now - endedAt >= BATCH_GRACE_MS) return status;
  return { status: "working", since: status.batch.workingSince };
}

/**
 * A session's first line and its later lines are written a moment apart. A
 * status time this little before the start is the same moment, not a
 * contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

/**
 * A file's modified time, as a time in the session's life, or null when it
 * could not be right. The system gives it with a fraction of a millisecond,
 * and no file of a session is written to before the session began.
 */
function writeTime(mtimeMs: number | undefined, startedAt: number | null, now: number) {
  if (mtimeMs === undefined) return null;
  const at = plausibleTime(Math.floor(mtimeMs), now);
  if (at === null || (startedAt !== null && at < startedAt - WRITE_ORDER_SLACK_MS)) return null;
  return at;
}

/**
 * When the session was last active, as far as its lines say: the newest time
 * that could be right of its last `lastUpdated`, its last message and the end
 * of its last tool call. Not the file's modified time, which a title Gemini CLI
 * adds to a session later moves on without the session doing anything. Null
 * when none could be right.
 */
export function lastActivity(state: ChatFileState, now: number): number | null {
  return newestOf(
    [state.updatedAt, state.messageAt, state.toolAt].map((at) => plausibleTime(at, now)),
  );
}

function newestOf(times: readonly (number | null)[]): number | null {
  const known = times.filter((at): at is number => at !== null);
  return known.length === 0 ? null : Math.max(...known);
}

export interface GeminiCliSessionInput {
  state: ChatFileState;
  /**
   * The project's folder in `tmp/`. Two projects can each hold a session of
   * one id, which `--session-id` allows, so it is part of the session's id.
   */
  slug: string;
  /** Whether the session was read from the folder Gemini CLI keeps under macOS Seatbelt. Part of its id. */
  seatbelt?: boolean;
  /** The folder the session's project is for, from its `.project_root`. */
  cwd: string | null;
  /** The file's modified time, as the `lstat` made before reading it gave it. */
  writtenAt?: number;
  /** When a subagent of the session last wrote to its own file, if one has (`subagentWrites.ts`). */
  subagentWrittenAt?: number;
  now: number;
}

/**
 * One Gemini CLI session in the shared model.
 *
 * - The status is the one its lines replay to (`mapGeminiCliStatus`): working,
 *   idle, failed or unknown, never "needs-you" or "finished". A reply with a
 *   tool call that has not ended is working since the newest prompt while the
 *   session's newest write is less than `QUIET_MS` old, and unknown after. That
 *   write is the newest time its own lines give, not the file's modified time,
 *   which a title a later start adds moves on, and the newest write of its
 *   subagents' files, which they add to while a tool of theirs runs. A batch
 *   of tool calls that ended less than `BATCH_GRACE_MS` ago is working since
 *   the newest prompt, as its tools' results will be.
 * - The id is the project's folder in `tmp/`, the session's own id and which
 *   of Gemini CLI's folders it is in, which stay the same from poll to poll.
 * - The name is the title Gemini CLI saved, then the folder's name, then the
 *   id. A prompt is never used as a name.
 * - The status time is that of the line the status comes from. An unknown
 *   status has none, and a time before the session began is not known.
 * - The last write is the newest modified time of the file and its subagents'
 *   files. A time that could not be right, or that is before the session
 *   began, is not known. Beside it, a subagent's write moves only how long a
 *   reply whose tool call has not ended stays working: the status and its
 *   time, the start and how long the session is listed come from the
 *   session's own lines.
 * - Its tokens are the counts of its newest reply left that has them, from
 *   the same read of the file (`newestGeminiCliTokens`).
 * - It runs in a terminal. There is no pid, no `alive` and no link: Gemini
 *   CLI's files name no process.
 */
export function geminiCliSession(input: GeminiCliSessionInput): Session | null {
  const { state, slug, cwd, now } = input;
  if (state.header === null) return null;
  const id = geminiCliSessionId(slug, state.header.sessionId, input.seatbelt === true);
  const project = projectOf(cwd);
  const startedAt = plausibleTime(state.header.startedAt, now);
  const fileWrite = writeTime(input.writtenAt, startedAt, now);
  const subagentWrite = writeTime(input.subagentWrittenAt, startedAt, now);
  const wroteAt = newestOf([lastActivity(state, now), subagentWrite]);
  const { status, since } = statusAt(state.status, now, wroteAt);

  let statusSince = status === "unknown" ? null : plausibleTime(since, now);
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
    surface: "terminal",
    // A title made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(state.summary ?? "") || project || id,
    cwd,
    project,
    status,
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  const lastWriteAt = newestOf([fileWrite, subagentWrite]);
  if (lastWriteAt !== null) session.lastWriteAt = lastWriteAt;
  if (state.tokens) session.tokens = { ...state.tokens };
  return session;
}
