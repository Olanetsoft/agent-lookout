import {
  mapMistralVibeStatus,
  type VibeHeld,
} from "../../../core/mapping/mistral-vibe/mistralVibeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { Envelope } from "./envelope.ts";

export const SOURCE_ID: SourceId = "mistral-vibe";

/**
 * A session's first state and its later writes are made a moment apart. A
 * status time this little before the start is the same moment, not a
 * contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

export interface MistralVibeSessionInput {
  /** Vibe's own id for the session, the name of its store's folder. */
  sessionId: string;
  /** The newest public state read: from the journal, else from the generation. Null when it is not known. */
  envelope: Envelope | null;
  /** The title to name it by, cleaned: the newest state's, else the generation's. */
  title: string | null;
  /** Its folder, from the generation's runtime state. */
  cwd: string | null;
  held: VibeHeld;
  /** True when a newer Vibe than Agent Lookout knows wrote the store. */
  tooNew?: boolean;
  /** The journal segment's modified time, as the `lstat` made this poll gave it. */
  writtenAt?: number;
  now: number;
}

/**
 * One Mistral Vibe session in the shared model.
 *
 * - The status comes from the newest public state and the lease
 *   (`mapMistralVibeStatus`). It is never "needs-you" yet.
 * - The app is not known: the files do not say whether a session runs in the
 *   terminal, an editor or the desktop app.
 * - It is named by its title, else its folder's name, else its id. Never by
 *   the first thing the person asked, which Vibe keeps beside the title.
 * - The status time is when the newest turn began while it works, when it
 *   ended once it is idle or failed, and the state's last change once it is
 *   finished. An unknown status has no time.
 * - The last write is the journal segment's modified time, moved by every
 *   record Vibe adds, and by the new segment each save begins.
 * - There is no pid, no `alive`, no link and no Stop: the process that holds
 *   a lease can hold many sessions' leases.
 */
export function mistralVibeSession(input: MistralVibeSessionInput): Session {
  const { sessionId, envelope, held, now } = input;
  const id = `${SOURCE_ID}:${sessionId}`;
  const status = mapMistralVibeStatus({
    statusType: envelope?.statusType,
    held,
    tooNew: input.tooNew,
  });

  const startedAt = plausibleTime(envelope?.createdAt ?? null, now);
  const updatedAt = plausibleTime(envelope?.updatedAt ?? null, now);
  let statusSince: number | null = null;
  if (status === "working") {
    statusSince = plausibleTime(envelope?.turnStartedAt ?? null, now) ?? updatedAt;
  } else if (status === "idle" || status === "failed") {
    statusSince = plausibleTime(envelope?.turnCompletedAt ?? null, now) ?? updatedAt;
  } else if (status === "finished") {
    statusSince = updatedAt;
  }
  if (
    statusSince !== null &&
    startedAt !== null &&
    statusSince < startedAt - WRITE_ORDER_SLACK_MS
  ) {
    // A status cannot have begun before the session did.
    statusSince = null;
  }

  const cwd = input.cwd;
  const project = projectOf(cwd);
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    name:
      (input.title === null ? undefined : sessionName(input.title)) ??
      project ??
      sessionName(sessionId) ??
      id,
    cwd,
    project,
    status,
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  // The system gives the time with a fraction of a millisecond. A segment cannot
  // have been written before its session began.
  const writtenAt =
    input.writtenAt === undefined ? null : plausibleTime(Math.floor(input.writtenAt), now);
  const beforeStart =
    writtenAt !== null && startedAt !== null && writtenAt < startedAt - WRITE_ORDER_SLACK_MS;
  if (writtenAt !== null && !beforeStart) session.lastWriteAt = writtenAt;
  return session;
}
