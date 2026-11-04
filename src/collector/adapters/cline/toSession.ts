import { mapClineStatus } from "../../../core/mapping/cline/clineMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { Manifest } from "./manifests.ts";

export const SOURCE_ID: SourceId = "cline";

/**
 * A manifest's times and its file's are written a moment apart. A time this
 * little before the start is the same moment, not a contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

export interface ClineSessionInput {
  manifest: Manifest;
  /**
   * Whether the session's own process runs: false when it has gone, or another
   * program was given its pid. Null when nothing can be asked, as for a manifest
   * with no pid, and when nothing was asked, as for a session that has ended.
   */
  processRuns: boolean | null;
  /** The manifest's modified time when its status was first read as it is now. */
  statusWrittenAt: number;
  /** The newest modified time of the manifest and the session's messages file. */
  writtenAt: number;
  now: number;
}

/**
 * One Cline session in the shared model.
 *
 * - The status comes from the manifest and whether its process runs
 *   (`mapClineStatus`). It is "needs-you", with the reason "permission", while
 *   Cline waits for a tool's approval, and never has a `waitingText`: what
 *   Cline asks is not in the manifest.
 * - The app is not known: the adapter keeps nothing that says which of Cline's
 *   programs a session runs in.
 * - It is named by its folder's name, else its id. Cline's title is by default
 *   the first line of its first prompt, so it is not kept (`manifests.ts`).
 * - The status time is when the manifest was written with its status, kept for
 *   as long as the status lasts, so a wait stays one wait. A session that ended
 *   has its `ended_at`, and one whose process went has its last write. An
 *   unknown status has no time.
 * - The last write is the newest of the manifest and the messages file, which
 *   Cline rewrites at each reply and each step of a turn. The messages file is
 *   looked up and never opened.
 * - It has its process's id only when that was asked about: a session that has
 *   ended names none. The process can be Cline's hub, which many sessions share.
 *   It has no link, no Jump and no Stop.
 */
export function clineSession(input: ClineSessionInput): Session {
  const { manifest, processRuns, now } = input;
  const { status, waitingReason } = mapClineStatus({ status: manifest.status, processRuns });
  const id = `${SOURCE_ID}:${manifest.sessionId}`;
  const project = projectOf(manifest.cwd);
  const startedAt = plausibleTime(manifest.startedAt, now);

  const notBeforeStart = (at: number | null) =>
    at !== null && startedAt !== null && at < startedAt - WRITE_ORDER_SLACK_MS ? null : at;
  const lastWriteAt = notBeforeStart(plausibleTime(Math.floor(input.writtenAt), now));

  let statusSince: number | null = null;
  if (status === "working" || status === "needs-you" || status === "idle") {
    statusSince = notBeforeStart(plausibleTime(Math.floor(input.statusWrittenAt), now));
  } else if (status === "finished" || status === "failed") {
    statusSince = notBeforeStart(plausibleTime(manifest.endedAt, now)) ?? lastWriteAt;
  }

  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    name: project ?? id,
    cwd: manifest.cwd,
    project,
    status,
    ...(waitingReason === undefined ? {} : { waitingReason }),
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  if (manifest.pid !== null && processRuns !== null) {
    session.pid = manifest.pid;
    session.alive = processRuns;
  }
  if (lastWriteAt !== null) session.lastWriteAt = lastWriteAt;
  return session;
}
