import {
  mapKiroV2Status,
  mapKiroV3Status,
  type KiroLiveness,
  type KiroV2Scan,
  type KiroV3Scan,
} from "../../../core/mapping/kiro-cli/kiroCliMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { KiroHeader } from "./headers.ts";

export const SOURCE_ID: SourceId = "kiro-cli";

/**
 * A session's header and its later writes are made a moment apart. A time this
 * little before the start is the same moment, not a contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

/** What one session is shown from. */
export interface KiroSessionInput {
  /** `sess_<uuid>` for a V3 session, `<uuid>` for a V2 one. */
  sessionId: string;
  header: KiroHeader;
  live: KiroLiveness;
  /** The lock's pid, while the session is open. */
  pid?: number;
  /** What its log says, or null when it has none. Only one of the two is given. */
  v3?: KiroV3Scan | null;
  v2?: KiroV2Scan | null;
  /** The header's modified time. */
  headerWrittenAt: number;
  /** The log's modified time, when it has one. */
  logWrittenAt?: number;
  /** The last poll that saw the session open, or not known to be closed. */
  openSeenAt?: number;
  now: number;
}

/**
 * One Kiro CLI session in the shared model.
 *
 * - The status comes from its lock and its log (`mapKiroV3Status`,
 *   `mapKiroV2Status`). It is "needs-you" only for a V3 session, with the reason
 *   "permission" for a tool's approval and "other" for anything else Kiro
 *   asks, and never has a `waitingText`: what Kiro asks is never kept.
 * - It is named by the title Kiro's model gave it or the person set, else its
 *   folder's name, else its ID. A V2 header's title is never read, as it is the
 *   first prompt word for word, so a V2 session takes its folder's name. A
 *   prompt is never read for a name.
 * - The status time is when its wait began while it needs you, kept for as long
 *   as anything it waits on stays open, when the turn started while it works,
 *   when the turn ended while it is idle, else when its log, or its header with
 *   no log, was last written. A finished session has been so since the later of
 *   that and the last poll that saw it open. An unknown status has no time.
 * - The last write is its log's modified time.
 * - It has the lock's pid while it is open. There is no link, no Jump and no
 *   Stop, and the app is not known: the V3 store is the Kiro IDE's too.
 */
export function kiroCliSession(input: KiroSessionInput): Session {
  const { header, live, now } = input;
  const v3 = input.v3 !== undefined;
  const { status, waitingReason } = v3
    ? mapKiroV3Status(live, input.v3 ?? null)
    : mapKiroV2Status(live, input.v2 ?? null);
  const id = `${SOURCE_ID}:${input.sessionId}`;
  const cwd = header.folder;
  const project = projectOf(cwd);
  const startedAt = plausibleTime(header.createdAt, now);

  const notBeforeStart = (at: number | null) =>
    at !== null && startedAt !== null && at < startedAt - WRITE_ORDER_SLACK_MS ? null : at;
  const written = (at: number | undefined) =>
    at === undefined ? null : notBeforeStart(plausibleTime(Math.floor(at), now));
  const lastWritten = written(input.logWrittenAt) ?? written(input.headerWrittenAt);

  let statusSince: number | null = null;
  if (status === "needs-you") {
    statusSince = notBeforeStart(plausibleTime(input.v3?.waitingSince ?? null, now));
  } else if (status === "working") {
    const began = v3 ? (input.v3?.turnAt ?? null) : (input.v2?.promptAt ?? null);
    statusSince = notBeforeStart(plausibleTime(began, now));
  } else if (status === "idle") {
    const ended = v3 && input.v3?.lastTurn === "end" ? input.v3.turnAt : null;
    statusSince = notBeforeStart(plausibleTime(ended, now)) ?? lastWritten;
  } else if (status === "finished") {
    const seen =
      input.openSeenAt === undefined ? null : notBeforeStart(plausibleTime(input.openSeenAt, now));
    statusSince =
      seen === null || lastWritten === null ? (seen ?? lastWritten) : Math.max(seen, lastWritten);
  }

  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // A name made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(header.title ?? "") || project || id,
    cwd,
    project,
    status,
    ...(status === "needs-you" && waitingReason ? { waitingReason } : {}),
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  if (live === "open" && input.pid !== undefined) {
    session.pid = input.pid;
    session.alive = true;
  }
  const lastWriteAt = written(input.logWrittenAt);
  if (lastWriteAt !== null) session.lastWriteAt = lastWriteAt;
  return session;
}
