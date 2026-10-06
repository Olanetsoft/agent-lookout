import { mapStatusFileApp, mapStatusFileStatus } from "../../../core/mapping/statusFileMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { plausibleTime } from "../../../core/time.ts";
import { sessionName } from "../../../core/text.ts";
import type { StatusFile } from "./statusFile.ts";

export const SOURCE_ID: SourceId = "status-files";

export interface StatusFileSessionInput {
  /** The file's name in the folder, which is what tells one session from another. */
  fileName: string;
  file: StatusFile;
  /** When the status began, already checked: see the adapter. */
  statusSince: number | null;
  /** Whether the file's process exists, when it names one. */
  alive?: boolean;
  /** The file's modified time, from the open file it was read from. */
  writtenAt?: number;
  now: number;
}

/**
 * A file's `since` is written into it, so the file cannot have been written
 * before it. A time this little before is the same moment, rounded.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

/**
 * One status file's session in the shared model.
 *
 * - The id is the file's name, so a session keeps its id for as long as its
 *   file keeps its name.
 * - The agent is the file's own `agent`, shown where the agent is named.
 * - The name is the file's `name`, then its folder's last part, then the file's
 *   name without `.json`, cleaned and cut as `name` is, then the agent.
 * - The last write is the file's own modified time, since an agent rewrites its
 *   file as it works. A time that could not be right, or that is before the
 *   `since` the file holds, as a copy that kept an older time can be, is not
 *   known.
 * - The app is the file's `app` when it is `terminal`, `vscode` or `desktop`,
 *   and not known otherwise.
 * - There is no start time, no link and no Jump: the file says nothing of
 *   them, and nothing in it is used as a link.
 */
export function statusFileSession(input: StatusFileSessionInput): Session {
  const { fileName, file, statusSince, now } = input;
  const cwd = file.cwd ?? null;
  const project = projectOf(cwd);
  const mapped = mapStatusFileStatus(file);
  const session: Session = {
    id: `${SOURCE_ID}:${fileName}`,
    source: SOURCE_ID,
    agent: file.agent,
    surface: mapStatusFileApp(file.app),
    // The file's name is as untrusted as its contents, so it is cleaned and cut
    // as a name in the file is. The agent is never empty, so there is always one.
    name: file.name ?? project ?? sessionName(fileName.replace(/\.json$/, "")) ?? file.agent,
    cwd,
    project,
    ...mapped,
    startedAt: null,
    statusSince,
    links: {},
    stale: isStale({ status: mapped.status, statusSince }, now),
  };
  if (file.pid !== undefined) {
    session.pid = file.pid;
    if (input.alive !== undefined) session.alive = input.alive;
  }
  // The system gives the time with a fraction of a millisecond.
  const writtenAt =
    input.writtenAt === undefined ? null : plausibleTime(Math.floor(input.writtenAt), now);
  const given = plausibleTime(file.since, now);
  const beforeSince =
    writtenAt !== null && given !== null && writtenAt < given - WRITE_ORDER_SLACK_MS;
  if (writtenAt !== null && !beforeSince) session.lastWriteAt = writtenAt;
  return session;
}
