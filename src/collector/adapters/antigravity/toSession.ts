import {
  mapAntigravityStatus,
  type AntigravityLiveness,
} from "../../../core/mapping/antigravityMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { TranscriptState } from "./transcriptFile.ts";

export const SOURCE_ID: SourceId = "antigravity-cli";

/**
 * A conversation's first step and its later files are written a moment apart.
 * A time this little before the start is the same moment, not a contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

export interface AntigravitySessionInput {
  /** In lower case, from the folder's name. */
  conversationId: string;
  state: TranscriptState;
  live: AntigravityLiveness;
  /**
   * The approval the conversation's program waits for, from its log, when the
   * transcript has no step yet at the one that waits (`waitsForApproval`).
   */
  waiting?: { tool: string; since: number | null } | null;
  /** The title agy gave it, from its annotation file. */
  title?: string | null;
  /** The folder its program works in, from that program's log. */
  folder?: string | null;
  /** The newest modified time of the conversation's transcript, database and database log, from the `lstat`s made this poll. */
  writtenAt: number | null;
  now: number;
}

/**
 * One Antigravity CLI conversation in the shared model.
 *
 * - The status comes from the transcript's last step and whether an agy
 *   program may have the conversation open (`mapAntigravityStatus`). It needs
 *   you, for permission, while its program's log says it waits for approval,
 *   with the tool agy names, such as `RunCommand`, as the detail.
 * - The app is the terminal: the CLI runs in one.
 * - It is named by the title agy gave it, else its folder's name, else its
 *   conversation id, which `agy --conversation <id>` takes. The folder is the
 *   one its program works in, when that program's log says.
 * - The status time is when the run of steps that say what the last one says
 *   began: a working conversation since its turn's first step, an idle one
 *   since the step that ended its turn, and one that needs you since agy began
 *   to ask. A finished one has been so since its last step. An unknown status
 *   has no time.
 * - The last write is the newest modified time of its transcript, its
 *   database and its database's log.
 * - There is no pid, no `alive`, no link and no Stop: no agy program is tied to
 *   one conversation surely enough.
 */
export function antigravitySession(input: AntigravitySessionInput): Session {
  const { conversationId, state, live, now } = input;
  const id = `${SOURCE_ID}:${conversationId}`;
  const waiting = input.waiting ?? null;
  const status = mapAntigravityStatus({ last: state.last, live, asking: waiting !== null });

  const startedAt = plausibleTime(state.firstAt, now);
  let statusSince: number | null = null;
  if (status === "working" || status === "idle" || status === "failed") {
    statusSince = plausibleTime(state.since, now);
  } else if (status === "needs-you") {
    statusSince = plausibleTime(waiting?.since ?? null, now) ?? plausibleTime(state.lastAt, now);
  } else if (status === "finished") {
    statusSince = plausibleTime(state.lastAt, now);
  }
  if (
    statusSince !== null &&
    startedAt !== null &&
    statusSince < startedAt - WRITE_ORDER_SLACK_MS
  ) {
    // A status cannot have begun before the conversation did.
    statusSince = null;
  }

  const cwd = input.folder ?? null;
  const project = projectOf(cwd);
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "terminal",
    name: input.title ?? project ?? sessionName(conversationId) ?? id,
    cwd,
    project,
    status,
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  if (status === "needs-you" && waiting !== null) {
    session.waitingReason = "permission";
    session.waitingDetail = waiting.tool;
  }
  const writtenAt = plausibleTime(input.writtenAt, now);
  const beforeStart =
    writtenAt !== null && startedAt !== null && writtenAt < startedAt - WRITE_ORDER_SLACK_MS;
  if (writtenAt !== null && !beforeStart) session.lastWriteAt = writtenAt;
  return session;
}
