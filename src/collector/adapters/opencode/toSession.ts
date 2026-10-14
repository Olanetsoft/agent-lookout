import {
  mapOpencodeStatus,
  opencodeStatusSince,
} from "../../../core/mapping/opencode/opencodeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { SessionRow } from "./sessionRows.ts";

export const SOURCE_ID: SourceId = "opencode";

/** The times OpenCode wrote anything of a session: its own row, its newest message and that message's parts. */
function writeTimes(row: SessionRow): number[] {
  return [row.updatedAt, row.message?.updatedAt, row.message?.partsUpdatedAt].filter(
    (value): value is number => value !== null && value !== undefined,
  );
}

/**
 * The newest time OpenCode wrote anything of a session, as far as the rows
 * read say: the session's own row, its newest message or that message's
 * parts. Null when none could be right.
 */
export function lastActivity(row: SessionRow, now: number): number | null {
  const times = writeTimes(row)
    .map((value) => plausibleTime(value, now))
    .filter((value): value is number => value !== null);
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * Whether a session is listed: something of it was written in the last 24
 * hours. Kept by the newest time as it was written, so a time ahead of a
 * clock set back keeps a session, as a clock that steps backwards never hides
 * one.
 */
export function isListed(row: SessionRow, now: number): boolean {
  const times = writeTimes(row);
  return times.length > 0 && isWithinRetention(Math.max(...times), now);
}

export interface OpencodeSessionInput {
  row: SessionRow;
  /** Whether OpenCode may have it open: an OpenCode program runs, or whether one does is not known. */
  open: boolean;
  now: number;
}

/**
 * One OpenCode session in the shared model, or null when nothing of it was
 * written in the last 24 hours, or no time of it is known.
 *
 * - The status comes from its newest message and whether OpenCode may have
 *   it open (`mapOpencodeStatus`). It is never "needs-you".
 * - The name is OpenCode's title, or the folder's name while the title is
 *   still OpenCode's placeholder, or the id.
 * - The app is not known: the database names no program.
 * - There is no last write: OpenCode keeps every session in one file, so no
 *   file's modified time says when one session was last written.
 * - There is no pid, Jump, Stop, link or token count.
 */
export function opencodeSession(input: OpencodeSessionInput): Session | null {
  const { row, open, now } = input;
  if (!isListed(row, now)) return null;
  const activityAt = lastActivity(row, now);

  const id = `${SOURCE_ID}:${row.id}`;
  const cwd = row.folder;
  const project = projectOf(cwd);
  const message = row.message;
  const status = mapOpencodeStatus({ message, open, now });
  const statusSince = opencodeStatusSince(
    status,
    {
      sessionCreatedAt: row.createdAt,
      messageCreatedAt: message?.createdAt ?? null,
      userCreatedAt: row.userCreatedAt,
      completedAt: message?.completedAt ?? null,
      activityAt,
    },
    now,
  );
  return {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // A title made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(row.title ?? "") || project || id,
    cwd,
    project,
    status,
    startedAt: plausibleTime(row.createdAt, now),
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
}
