import { mapPiStatus } from "../../../core/mapping/pi/piMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SessionStatus, SourceId } from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { PiSessionFile } from "./sessionFile.ts";

export const SOURCE_ID: SourceId = "pi";

/** Pi makes a file a moment after its header's time, and a disk can round that down. */
const WRITE_ORDER_SLACK_MS = 2_000;

/**
 * What an agent that says more than Pi does gave for one session: its status,
 * and since when, as Prime Agent's adapter works them out from its leases and
 * its workers' journals (`../prime-agent/status.ts`).
 */
export interface PiEvidence {
  status: SessionStatus;
  /** When that status began, for one that is working or idle. Null when not known. */
  since: number | null;
}

export interface PiSessionInput {
  file: PiSessionFile;
  /** Whether Pi may have it open: a `pi` program runs, or whether one does is not known. */
  open: boolean;
  /** The file's modified time. */
  writtenAt: number;
  now: number;
  /** The source it is listed under. Defaults to Pi's: Kimchi's adapter gives its own. */
  sourceId?: SourceId;
  /**
   * The status a profile's own reader gave, which wins over `open`. Left out
   * by Pi and Kimchi, whose sessions are then made as before.
   */
  evidence?: PiEvidence;
}

/**
 * One Pi session in the shared model.
 *
 * - The status is unknown while Pi may have it open and finished once it cannot
 *   (`mapPiStatus`). It never shows as working or as needing you.
 * - The name is the one a person or an extension gave it, else its folder's, else
 *   its id. Pi names no session by itself: its own list shows the first prompt
 *   where there is no name, and that is never parsed. A profile that reads no
 *   names, as Kimchi's, gives a file with none, so its folder's name is taken.
 * - The status time of a finished session is the file's last write, the last
 *   thing known of it. An unknown status has no time.
 * - The app is not known: the file does not say which of Pi's modes wrote it. It
 *   has no pid, no link, no Jump and no Stop. There is no last write: the page
 *   says how quiet a working session is, and this is never one.
 *
 * With `evidence`, as Prime Agent's adapter gives, the status is the one it
 * gives. A finished session's time is the file's last write as above, and a
 * working or idle one's is the time it gives, when that could be real. A
 * working session has a last write too, the file's, unless that is before
 * the session started.
 */
export function piSession({
  file,
  open,
  writtenAt,
  now,
  sourceId = SOURCE_ID,
  evidence,
}: PiSessionInput): Session {
  const status = evidence === undefined ? mapPiStatus(open) : evidence.status;
  const id = `${sourceId}:${file.id}`;
  const project = projectOf(file.cwd);
  const startedAt = plausibleTime(file.startedAt, now);
  const lastWrite = plausibleTime(Math.floor(writtenAt), now);
  const before =
    startedAt !== null && lastWrite !== null && lastWrite < startedAt - WRITE_ORDER_SLACK_MS;
  const session: Session = {
    id,
    source: sourceId,
    surface: "unknown",
    // A name made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(file.ownName ?? "") || project || id,
    cwd: file.cwd,
    project,
    status,
    startedAt,
    statusSince: status === "finished" && !before ? lastWrite : null,
    links: {},
    stale: false,
  };
  if (evidence === undefined) return session;
  if (status === "working" || status === "idle") {
    session.statusSince = plausibleTime(evidence.since, now);
  }
  if (status === "working" && lastWrite !== null && !before) session.lastWriteAt = lastWrite;
  return session;
}
