import { createHash } from "node:crypto";

import { mapCrushStatus } from "../../../core/mapping/crush/crushMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { SessionRow } from "./sessionRows.ts";

export const SOURCE_ID: SourceId = "crush";

/** How much of the hash of a project's folder goes into its sessions' ids. */
const FOLDER_HASH_LENGTH = 12;

/**
 * The start of the ids of a project's sessions: `crush:<hash of its folder>/`.
 * The poller compares each project apart by it, and a copied folder's database,
 * whose sessions keep their ids, is told from the first. It names no folder.
 */
export function projectPrefix(folder: string): string {
  const hash = createHash("sha256").update(folder).digest("hex").slice(0, FOLDER_HASH_LENGTH);
  return `${SOURCE_ID}:${hash}/`;
}

/**
 * Whether a session is listed: Crush wrote it in the last 24 hours. Kept by its
 * time as it was written, so a time ahead of a clock set back keeps a session.
 */
export function isListed(row: SessionRow, now: number): boolean {
  return row.updatedAt !== null && isWithinRetention(row.updatedAt, now);
}

export interface CrushSessionInput {
  /** The project's folder, from Crush's list of projects: its database holds no folder. */
  folder: string;
  row: SessionRow;
  /** Whether Crush may have it open: a Crush program runs, or whether one does is not known. */
  open: boolean;
  now: number;
}

/**
 * One Crush session in the shared model.
 *
 * - The status is unknown while Crush may have it open and finished once it
 *   cannot (`mapCrushStatus`). It never shows as working or as needing you.
 * - It is named by its folder's name, else its id. Crush's title can be the start
 *   of the first prompt, so it is never asked for (`sessionRows.ts`).
 * - The status time of a finished session is Crush's last write of it. An unknown
 *   status has no time.
 * - The app is not known. It has no pid, no link, no Jump and no Stop. There is no
 *   last write: the page says how quiet a working session is, and this is never
 *   one.
 */
export function crushSession({ folder, row, open, now }: CrushSessionInput): Session {
  const status = mapCrushStatus(open);
  const id = `${projectPrefix(folder)}${row.id}`;
  const project = projectOf(folder);
  return {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is, since a folder's name can be longer.
    name: sessionName(project ?? "") || id,
    cwd: folder,
    project,
    status,
    startedAt: plausibleTime(row.createdAt, now),
    statusSince: status === "finished" ? plausibleTime(row.updatedAt, now) : null,
    links: {},
    stale: false,
  };
}
