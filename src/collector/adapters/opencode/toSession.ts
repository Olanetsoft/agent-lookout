import {
  mapOpencode2Status,
  opencode2StatusSince,
} from "../../../core/mapping/opencode/opencode2Mapping.ts";
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
import type { MessageRow, SessionRow } from "./sessionRows.ts";

export const SOURCE_ID: SourceId = "opencode";

/**
 * The times OpenCode wrote anything of a session: its own row, its newest
 * message and that message's parts, or for OpenCode 2 when its turn began and
 * ended, which leave `time_updated` alone.
 */
function writeTimes(row: SessionRow): number[] {
  return [
    row.updatedAt,
    row.message?.updatedAt,
    row.message?.partsUpdatedAt,
    row.turn?.claimedAt,
    row.turn?.idleAt,
  ].filter((value): value is number => typeof value === "number");
}

/**
 * The newest time OpenCode wrote anything of a session, as far as the rows
 * read say (`writeTimes`). Null when none could be right.
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
  /** When `ps` last showed no OpenCode program, if it has. */
  noOpencodeAt?: number | null;
}

/**
 * The newest message with no wait, if its wait began before `ps` last showed
 * no OpenCode program. A wait lives in a running OpenCode's memory, so one
 * that began before none ran was left by an OpenCode that was killed or
 * crashed, and no one is being asked: its `running` part just stays as it was.
 * The step is then like any other that was cut off.
 */
function withoutLeftWait(
  message: MessageRow | null,
  noOpencodeAt: number | null,
): MessageRow | null {
  if (message === null || noOpencodeAt === null) return message;
  const { askedAt } = message;
  return typeof askedAt === "number" && askedAt < noOpencodeAt
    ? { ...message, askedAt: null }
    : message;
}

/**
 * One OpenCode session in the shared model, or null when nothing of it was
 * written in the last 24 hours, or no time of it is known.
 *
 * - The status of a row of `session` comes from its newest message and whether
 *   OpenCode may have it open (`mapOpencodeStatus`). It is "needs-you", with
 *   the reason "question", while OpenCode asks a question or asks for a plan's
 *   approval. It never has a `waitingText`: what OpenCode asks is never read.
 *   A wait ends with OpenCode: a session it left waiting is finished, with no
 *   reason, and no longer asks once OpenCode runs again (`withoutLeftWait`).
 * - The status of a row of `session_v2` comes from how its turn stands and
 *   whether OpenCode may have it open (`mapOpencode2Status`). It is never
 *   "needs-you": OpenCode 2 keeps its waits in memory.
 * - The name is OpenCode's title, or the slug of a row of `session_v2`, or the
 *   folder's name while the title is still OpenCode's placeholder, or the id.
 * - The app is not known: the database names no program.
 * - There is no last write: OpenCode keeps every session in one file, so no
 *   file's modified time says when one session was last written.
 * - Its tokens are the counts of its newest reply that ended with some, from
 *   the same read of the database (`replyTokensOf` in `sessionRows.ts`),
 *   when they could be right. A row of `session_v2` has none, and is marked
 *   `tokensNotRead`, since OpenCode 2 records them in a table that is not read.
 * - There is no pid, Jump, Stop or link.
 */
export function opencodeSession(input: OpencodeSessionInput): Session | null {
  const { row, open, now, noOpencodeAt = null } = input;
  if (!isListed(row, now)) return null;
  const activityAt = lastActivity(row, now);

  const id = `${SOURCE_ID}:${row.id}`;
  const cwd = row.folder;
  const project = projectOf(cwd);
  const message = withoutLeftWait(row.message, noOpencodeAt);
  const status =
    row.turn === null
      ? mapOpencodeStatus({ message, open, now })
      : mapOpencode2Status({ turn: row.turn, open });
  const statusSince =
    row.turn === null
      ? opencodeStatusSince(
          status,
          {
            sessionCreatedAt: row.createdAt,
            messageCreatedAt: message?.createdAt ?? null,
            userCreatedAt: row.userCreatedAt,
            completedAt: message?.completedAt ?? null,
            askedAt: message?.askedAt ?? null,
            activityAt,
          },
          now,
        )
      : opencode2StatusSince(status, { turn: row.turn, activityAt }, now);
  const session: Session = {
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
  if (status === "needs-you") session.waitingReason = "question";
  if (row.tokens) session.tokens = { ...row.tokens };
  if (row.turn !== null) session.tokensNotRead = true;
  return session;
}
