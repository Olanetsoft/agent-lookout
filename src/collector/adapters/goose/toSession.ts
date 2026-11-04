import { mapGooseStatus } from "../../../core/mapping/goose/gooseMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { SessionRow } from "./sessionRows.ts";

export const SOURCE_ID: SourceId = "goose";

/**
 * Whether a session is listed: Goose wrote it in the last 24 hours. Kept by its
 * time as it was written, so a time ahead of a clock set back keeps a session.
 */
export function isListed(row: SessionRow, now: number): boolean {
  return row.updatedAt !== null && isWithinRetention(row.updatedAt, now);
}

export interface GooseSessionInput {
  row: SessionRow;
  /** Whether Goose may have it open: a Goose program runs, or whether one does is not known. */
  open: boolean;
  now: number;
}

/**
 * One Goose session in the shared model.
 *
 * - The status is unknown while Goose may have it open and finished once it
 *   cannot (`mapGooseStatus`). It never shows as working or as needing you.
 * - The name is the one the person gave it or an ACP client sent, else its
 *   folder's, else its id. Goose's own title is never asked for (`sessionRows.ts`).
 * - The status time of a finished session is Goose's last write of it. An
 *   unknown status has no time.
 * - The app is not known: the row does not say which of Goose's programs wrote
 *   it. It has no pid, no link, no Jump and no Stop. There is no last write: the
 *   page says how quiet a working session is, and this is never one.
 */
export function gooseSession({ row, open, now }: GooseSessionInput): Session {
  const status = mapGooseStatus(open);
  const id = `${SOURCE_ID}:${row.id}`;
  const project = projectOf(row.folder);
  return {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // A name made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(row.ownName ?? "") || project || id,
    cwd: row.folder,
    project,
    status,
    startedAt: plausibleTime(row.createdAt, now),
    statusSince: status === "finished" ? plausibleTime(row.updatedAt, now) : null,
    links: {},
    stale: false,
  };
}
