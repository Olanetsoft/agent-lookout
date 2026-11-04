import { mapPiStatus } from "../../../core/mapping/pi/piMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { PiSessionFile } from "./sessionFile.ts";

export const SOURCE_ID: SourceId = "pi";

/** Pi makes a file a moment after its header's time, and a disk can round that down. */
const WRITE_ORDER_SLACK_MS = 2_000;

export interface PiSessionInput {
  file: PiSessionFile;
  /** Whether Pi may have it open: a `pi` program runs, or whether one does is not known. */
  open: boolean;
  /** The file's modified time. */
  writtenAt: number;
  now: number;
}

/**
 * One Pi session in the shared model.
 *
 * - The status is unknown while Pi may have it open and finished once it cannot
 *   (`mapPiStatus`). It never shows as working or as needing you.
 * - The name is the one a person or an extension gave it, else its folder's, else
 *   its id. Pi names no session by itself: its own list shows the first prompt
 *   where there is no name, and that is never parsed.
 * - The status time of a finished session is the file's last write, the last
 *   thing known of it. An unknown status has no time.
 * - The app is not known: the file does not say which of Pi's modes wrote it. It
 *   has no pid, no link, no Jump and no Stop. There is no last write: the page
 *   says how quiet a working session is, and this is never one.
 */
export function piSession({ file, open, writtenAt, now }: PiSessionInput): Session {
  const status = mapPiStatus(open);
  const id = `${SOURCE_ID}:${file.id}`;
  const project = projectOf(file.cwd);
  const startedAt = plausibleTime(file.startedAt, now);
  const lastWrite = plausibleTime(Math.floor(writtenAt), now);
  const before =
    startedAt !== null && lastWrite !== null && lastWrite < startedAt - WRITE_ORDER_SLACK_MS;
  return {
    id,
    source: SOURCE_ID,
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
}
