import type { OhMyPiStatus } from "../../../core/mapping/oh-my-pi/ohMyPiMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { OmpSessionFile } from "./sessionFile.ts";

export const SOURCE_ID: SourceId = "oh-my-pi";

/** A session's ID in the session model, from the ID its header gives. */
export function ohMyPiId(sessionId: string): string {
  return `${SOURCE_ID}:${sessionId}`;
}

export interface OhMyPiSessionInput {
  file: OmpSessionFile;
  status: OhMyPiStatus;
  /** The file's last write, or null when that time cannot be right. */
  writtenAt: number | null;
  now: number;
}

/**
 * One Oh My Pi session in the shared model.
 *
 * - The status is `ohMyPiStatusOf`'s.
 * - The name is the title the person or a model gave it, as its title slot
 *   holds it, else its folder's, else its ID. A model's title in a Codex
 *   session's copy, which can be the first prompt typed in Codex, and a title
 *   with no source are never turned into text from the slot, and the
 *   header's copy is dropped with the parsed header.
 * - The folder is the one its header names, where it began, never the name
 *   of the folder Oh My Pi keeps its file in.
 * - The last write is shown only while it works.
 * - The app is not known, and there is no pid, link, Jump or Stop.
 */
export function ohMyPiSession(input: OhMyPiSessionInput): Session {
  const { file, status, now } = input;
  const id = ohMyPiId(file.id);
  const project = projectOf(file.cwd);
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is.
    name: sessionName(file.title ?? "") || sessionName(project ?? "") || id,
    cwd: file.cwd,
    project,
    status: status.status,
    startedAt: plausibleTime(file.startedAt, now),
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
