import {
  mapAntigravityStatus,
  type AntigravityLiveness,
} from "../../../core/mapping/antigravityMapping.ts";
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
  /** The newest modified time of the conversation's files, from the `lstat`s made this poll. */
  writtenAt: number | null;
  now: number;
}

/**
 * One Antigravity CLI conversation in the shared model.
 *
 * - The status comes from the transcript's last step and whether an agy
 *   program may have the conversation open (`mapAntigravityStatus`). It is
 *   never "needs-you".
 * - The app is the terminal: the CLI runs in one.
 * - It is named by its conversation id, which `agy --conversation <id>` takes.
 *   The transcript holds no title and no folder outside the conversation's own
 *   text, so there is no folder, no project and no branch.
 * - The status time is when the run of steps that say what the last one says
 *   began: a working conversation since its turn's first step, an idle one
 *   since the step that ended its turn. A finished one has been so since its
 *   last step. An unknown status has no time.
 * - The last write is the newest modified time of its transcript, its
 *   database and its database's log.
 * - There is no pid, no `alive`, no link and no Stop: no agy program is tied to
 *   one conversation surely enough.
 */
export function antigravitySession(input: AntigravitySessionInput): Session {
  const { conversationId, state, live, now } = input;
  const id = `${SOURCE_ID}:${conversationId}`;
  const status = mapAntigravityStatus({ last: state.last, live });

  const startedAt = plausibleTime(state.firstAt, now);
  let statusSince: number | null = null;
  if (status === "working" || status === "idle" || status === "failed") {
    statusSince = plausibleTime(state.since, now);
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

  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "terminal",
    name: sessionName(conversationId) ?? id,
    cwd: null,
    project: null,
    status,
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  const writtenAt = plausibleTime(input.writtenAt, now);
  const beforeStart =
    writtenAt !== null && startedAt !== null && writtenAt < startedAt - WRITE_ORDER_SLACK_MS;
  if (writtenAt !== null && !beforeStart) session.lastWriteAt = writtenAt;
  return session;
}
