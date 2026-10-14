import { createHash } from "node:crypto";

import type { GeminiCliStatus } from "../../../core/mapping/gemini-cli/geminiCliMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { ChatFileState } from "./chatFile.ts";

export const SOURCE_ID: SourceId = "gemini-cli";

/**
 * A session's id in Agent Lookout: Gemini CLI's own id, then a dot and a short
 * hash of the project's folder in `tmp/`, since two projects can each hold a
 * session of one id. The hash keeps the id the same from poll to poll without
 * writing the project's name into the history. Gemini CLI's ids hold no dot.
 */
export function geminiCliSessionId(slug: string, sessionId: string): string {
  const project = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  return `${SOURCE_ID}:${sessionId}.${project}`;
}

/**
 * How long a batch of tool calls that ended is taken to be working while it is
 * the newest message. Gemini CLI writes the batch, then does other work, which
 * can ask the network, before it writes the tools' results. A batch still the
 * newest after this long, as a tool that stops the agent leaves it, is unknown.
 */
export const BATCH_GRACE_MS = 30_000;

/** The status the lines replay to, with a batch of tool calls that ended a moment ago taken as working. */
function statusAt(status: GeminiCliStatus, now: number): GeminiCliStatus {
  if (status.status !== "unknown" || status.batch === undefined) return status;
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
 * When the session was last active, as far as its lines say: the newest time
 * that could be right of its last `lastUpdated`, its last message and the end
 * of its last tool call. Not the file's modified time, which a title Gemini CLI
 * adds to a session later moves on without the session doing anything. Null
 * when none could be right.
 */
export function lastActivity(state: ChatFileState, now: number): number | null {
  const times = [state.updatedAt, state.messageAt, state.toolAt]
    .map((at) => plausibleTime(at, now))
    .filter((at): at is number => at !== null);
  return times.length === 0 ? null : Math.max(...times);
}

export interface GeminiCliSessionInput {
  state: ChatFileState;
  /**
   * The project's folder in `tmp/`. Two projects can each hold a session of
   * one id, which `--session-id` allows, so it is part of the session's id.
   */
  slug: string;
  /** The folder the session's project is for, from its `.project_root`. */
  cwd: string | null;
  /** The file's modified time, as the `lstat` made before reading it gave it. */
  writtenAt?: number;
  now: number;
}

/**
 * One Gemini CLI session in the shared model.
 *
 * - The status is the one its lines replay to (`mapGeminiCliStatus`): working,
 *   idle or unknown, never "needs-you", "finished" or "failed". A batch of tool
 *   calls that ended less than `BATCH_GRACE_MS` ago is working since the newest
 *   prompt, as its tools' results will be.
 * - The id is the project's folder in `tmp/` and the session's own id, which
 *   stay the same from poll to poll.
 * - The name is the title Gemini CLI saved, then the folder's name, then the
 *   id. A prompt is never used as a name.
 * - The status time is that of the line the status comes from. An unknown
 *   status has none, and a time before the session began is not known.
 * - The last write is the file's modified time. A time that could not be
 *   right, or that is before the session began, is not known.
 * - It runs in a terminal. There is no pid, no `alive` and no link: Gemini
 *   CLI's files name no process.
 */
export function geminiCliSession(input: GeminiCliSessionInput): Session | null {
  const { state, slug, cwd, now } = input;
  if (state.header === null) return null;
  const id = geminiCliSessionId(slug, state.header.sessionId);
  const project = projectOf(cwd);
  const { status, since } = statusAt(state.status, now);

  const startedAt = plausibleTime(state.header.startedAt, now);
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
  // The system gives the time with a fraction of a millisecond. A file cannot
  // have been written to before its session began.
  const writtenAt =
    input.writtenAt === undefined ? null : plausibleTime(Math.floor(input.writtenAt), now);
  const beforeStart =
    writtenAt !== null && startedAt !== null && writtenAt < startedAt - WRITE_ORDER_SLACK_MS;
  if (writtenAt !== null && !beforeStart) session.lastWriteAt = writtenAt;
  return session;
}
