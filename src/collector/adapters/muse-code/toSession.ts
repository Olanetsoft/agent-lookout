import type { MuseCodeStatus } from "../../../core/mapping/muse-code/museCodeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";

export const SOURCE_ID: SourceId = "muse-code";

/** A session's ID in the session model, from its folder's name, the session's own ID. */
export function museCodeId(folderName: string): string {
  return `${SOURCE_ID}:${folderName}`;
}

/** A lowercase UUID of version 7 with the RFC variant: its version digit `7`, its variant digit one of `89ab`. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * When a session began: the time a version 7 UUID holds in its first 48 bits,
 * in milliseconds, when its folder's name is one with the RFC variant, else
 * the metadata record's time, else null. Muse Code names a session with a
 * version 7 UUID, but its own 0.1.0 export holds a version 4 one, which holds
 * no time.
 */
export function startedAtOf(folderName: string, metadataAt: number | null): number | null {
  if (UUID_V7.test(folderName)) {
    return Number.parseInt(folderName.slice(0, 8) + folderName.slice(9, 13), 16);
  }
  return metadataAt;
}

export interface MuseCodeSessionInput {
  /** The session folder's name, its ID. */
  folderName: string;
  /** The workspace folder its metadata record names, or null. */
  cwd: string | null;
  /** Its metadata record's time, or null. */
  metadataAt: number | null;
  status: MuseCodeStatus;
  /** The log's last write, or null when that time cannot be right. */
  writtenAt: number | null;
  now: number;
}

/**
 * One Muse Code session in the shared model.
 *
 * - The status is `museCodeStatusOf`'s.
 * - The name is the workspace folder's last part, else `muse-code:` and its
 *   ID. The session's own name, title, generated name and first prompt are
 *   never read: each is typed by the person or made from their words.
 * - The folder is the workspace its metadata record names, which can differ
 *   from the folder Muse Code was started in.
 * - The last write is shown only while it works.
 * - The app is not known, and there is no pid, link, Jump or Stop.
 */
export function museCodeSession(input: MuseCodeSessionInput): Session {
  const { folderName, cwd, status, now } = input;
  const id = museCodeId(folderName);
  const project = projectOf(cwd);
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is.
    name: sessionName(project ?? "") || id,
    cwd,
    project,
    status: status.status,
    startedAt: plausibleTime(startedAtOf(folderName, input.metadataAt), now),
    statusSince: status.since,
    links: {},
    stale: false,
  };
  if (status.waitingReason !== undefined) session.waitingReason = status.waitingReason;
  session.stale = isStale(session, now);
  const written = input.writtenAt === null ? null : plausibleTime(Math.floor(input.writtenAt), now);
  if (status.showsLastWrite && written !== null) session.lastWriteAt = written;
  return session;
}
