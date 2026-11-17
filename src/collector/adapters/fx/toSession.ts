import { mapFxStatus, type FxPrograms } from "../../../core/mapping/fx/fxMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { FxLog } from "./logFile.ts";

export const SOURCE_ID: SourceId = "fx";

/** fx writes a session's first line a moment before it is on disk, and a disk can round a time down. */
const WRITE_ORDER_SLACK_MS = 2_000;

export interface FxSessionInput {
  log: FxLog;
  /** Whether an fx program runs, by the last `ps` answer. */
  programs: FxPrograms;
  /** Whether every fx program running was missing from an answer taken more than 2 seconds after the log's last write. */
  writerGone: boolean;
  /** The log's modified time. */
  writtenAt: number;
  now: number;
}

/**
 * One fx session in the shared model.
 *
 * - The status is `mapFxStatus`'s, from the log's last turn and the fx
 *   programs `ps` lists. It never shows as idle or as needing you.
 * - The name is its folder's, else its id. fx's own titles are most often
 *   the first line of the person's prompt, and no line says which, so none is
 *   read.
 * - The last write is the log's own modified time, and nothing read from
 *   inside it. A finished session's status time is that write, and a failed
 *   one's is the time on the line that ended its turn. Neither is kept when
 *   it is earlier than the session's start, as for a time that cannot be
 *   right.
 * - The app is not known: the log names the host that made the session,
 *   which need not be the one that has it now, and it is not kept. There is
 *   no pid, no link, no Jump and no Stop.
 */
export function fxSession({ log, programs, writerGone, writtenAt, now }: FxSessionInput): Session {
  const status = mapFxStatus({ tail: log.tail, programs, writerGone, writtenAt, now });
  const id = `${SOURCE_ID}:${log.id}`;
  const project = projectOf(log.cwd);
  const startedAt = plausibleTime(log.createdAt, now);
  const notBeforeStart = (at: number | null) =>
    at !== null && startedAt !== null && at < startedAt - WRITE_ORDER_SLACK_MS ? null : at;
  const lastWrite = notBeforeStart(plausibleTime(Math.floor(writtenAt), now));
  let statusSince: number | null = null;
  if (status === "finished") statusSince = lastWrite;
  else if (status === "failed" && log.tail.turn === "ended") {
    statusSince = notBeforeStart(plausibleTime(log.tail.at, now));
  }
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is.
    name: sessionName(project ?? "") || id,
    cwd: log.cwd,
    project,
    status,
    startedAt,
    statusSince,
    links: {},
    stale: false,
  };
  if (lastWrite !== null) session.lastWriteAt = lastWrite;
  return session;
}
