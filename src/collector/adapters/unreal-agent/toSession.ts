import type { UnrealAgentLiveness } from "../../../core/mapping/unreal-agent/unrealAgentLiveness.ts";
import { mapUnrealAgentStatus } from "../../../core/mapping/unreal-agent/unrealAgentMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SessionStatus, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { UnrealAgentSessionFile } from "./sessionFile.ts";

export const SOURCE_ID: SourceId = "unreal-agent";

/** Unreal Agent writes a time a moment before it is on disk, and a disk can round a time down. */
const WRITE_ORDER_SLACK_MS = 2_000;

export interface UnrealAgentSessionInput {
  file: UnrealAgentSessionFile;
  /** Whether a program that could hold the session may still run. */
  liveness: UnrealAgentLiveness;
  /** The file's modified time. */
  writtenAt: number;
  now: number;
}

/**
 * One Unreal Agent session in the shared model.
 *
 * - The status is `mapUnrealAgentStatus`'s, from the file's lines and
 *   whether a program that could hold it runs. It never needs you: Unreal
 *   Agent asks for no approval and has no tool that asks a question.
 * - The name is its folder's, the one its shell commands run in, else its
 *   id. Unreal Agent gives a session no name.
 * - The last write is the file's own modified time. The status time is when
 *   the newest turn began, or the input waiting for one, for a working
 *   session; the newest item for an idle one; the failed reply for a failed
 *   one; and the last write for a finished one. None is kept when it is
 *   earlier than the session's start, as for a time that cannot be right.
 * - The app is not known: the file does not say whether the terminal app or
 *   the runner wrote it. There is no pid, no link, no Jump and no Stop.
 */
export function unrealAgentSession({
  file,
  liveness,
  writtenAt,
  now,
}: UnrealAgentSessionInput): Session {
  const status = mapUnrealAgentStatus({ replay: file.replay, liveness, writtenAt, now });
  const id = `${SOURCE_ID}:${file.id}`;
  const project = projectOf(file.folder);
  const startedAt = plausibleTime(file.createdAt, now);
  const notBeforeStart = (at: number | null) =>
    at !== null && startedAt !== null && at < startedAt - WRITE_ORDER_SLACK_MS ? null : at;
  const lastWrite = notBeforeStart(plausibleTime(Math.floor(writtenAt), now));
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is.
    name: sessionName(project ?? "") || id,
    cwd: file.folder,
    project,
    status,
    startedAt,
    statusSince: statusSince(file, status, lastWrite, now, notBeforeStart),
    links: {},
    stale: false,
  };
  session.stale = isStale(session, now);
  if (lastWrite !== null) session.lastWriteAt = lastWrite;
  return session;
}

function statusSince(
  file: UnrealAgentSessionFile,
  status: SessionStatus,
  lastWrite: number | null,
  now: number,
  notBeforeStart: (at: number | null) => number | null,
): number | null {
  const { replay } = file;
  let at: number | null;
  switch (status) {
    case "working":
      at = replay.pendingAt ?? replay.newestTurnAt;
      break;
    case "idle":
      at = replay.newestItemAt;
      break;
    case "failed":
      at = replay.newest?.kind === "reply" ? replay.newest.at : null;
      break;
    case "finished":
      return lastWrite;
    default:
      return null;
  }
  return notBeforeStart(plausibleTime(at, now));
}
